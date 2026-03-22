/**
 * ankiimport.js — Import an Anki .apkg deck into the jdict wiki.
 *
 * Each note has 5 fields: English, Japanese, Reading, Story, Picture.
 *
 * - If Japanese matches a jdict entry: create/update a wiki word page.
 * - Otherwise: write a card page to wiki/cards/.
 *
 * Usage:
 *   node ankiimport.js GJVL.apkg
 *   node ankiimport.js --apkg GJVL.apkg --db data/jdict.db
 */

const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { execSync } = require('child_process');
const AdmZip  = require('adm-zip');
const Database = require('better-sqlite3');
const sharp   = require('sharp');
const matter  = require('gray-matter');
const { v4: uuidv4 } = require('uuid');
const wiki    = require('./wiki');

const args    = require('minimist')(process.argv.slice(2));
const apkgPath = args._[0] || args.apkg;
const dbPath   = args.db || path.join(__dirname, 'data', 'jdict.db');
const limit    = args.limit ? parseInt(args.limit, 10) : null;

const CARDS_PATH  = path.join(__dirname, 'wiki', 'cards');
const IMAGES_PATH = path.join(__dirname, 'wiki', 'images');
const MAX_IMAGE_BYTES = 1 * 1024 * 1024; // 1 MB

// ---------------------------------------------------------------------------

function stripHtml(str) {
  if (!str) return '';
  return str
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

async function resizeImage(srcPath, destPath, maxBytes) {
  const size = fs.statSync(srcPath).size;
  if (size <= maxBytes) {
    const ext = path.extname(destPath);
    // Copy original — destPath already has the right extension
    fs.copyFileSync(srcPath, destPath);
    return;
  }
  // Over limit: convert to JPEG, step down quality until it fits
  for (const quality of [85, 70, 55, 40]) {
    const buf = await sharp(srcPath).jpeg({ quality }).toBuffer();
    if (buf.length <= maxBytes) {
      fs.writeFileSync(destPath, buf);
      return;
    }
  }
  // Last resort: also constrain dimensions
  const buf = await sharp(srcPath)
    .resize({ width: 800, withoutEnlargement: true })
    .jpeg({ quality: 40 })
    .toBuffer();
  fs.writeFileSync(destPath, buf);
}

// ---------------------------------------------------------------------------
// Parse the newer Anki media map format (protobuf sequence of MediaEntry).
// Each entry: field 1 = name (string), field 2 = size (varint), field 3 = sha1 (bytes).
// Entries are indexed; file "N" in the zip corresponds to the Nth entry.
// Returns { originalName: "N", ... }
function parseMediaProto(buf) {
  const nameToKey = {};
  let pos = 0;
  let idx = 0;
  while (pos < buf.length) {
    if (buf[pos] !== 0x0a) break; // expect field 1, wire type 2
    pos++;
    // read outer varint length
    let len = 0, shift = 0;
    while (true) {
      const b = buf[pos++];
      len |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    const end = pos + len;
    let name = null;
    while (pos < end) {
      const tag = buf[pos++];
      const fieldNum = tag >> 3;
      const wireType = tag & 0x7;
      if (wireType === 2) {
        let flen = 0, fs = 0;
        while (true) { const b = buf[pos++]; flen |= (b & 0x7f) << fs; fs += 7; if (!(b & 0x80)) break; }
        if (fieldNum === 1) name = buf.slice(pos, pos + flen).toString('utf8');
        pos += flen;
      } else if (wireType === 0) {
        while (buf[pos++] & 0x80) {} // skip varint
      } else if (wireType === 1) { pos += 8; }
        else if (wireType === 5) { pos += 4; }
    }
    pos = end;
    if (name) nameToKey[name] = String(idx);
    idx++;
  }
  return nameToKey;
}

function isZstdFile(filePath) {
  const buf = fs.readFileSync(filePath).slice(0, 4);
  return buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd;
}

// Decompress a zstd-compressed media file to a temp path; returns path to use.
// If not zstd, returns srcPath unchanged. Caller must clean up tmpOut if set.
function decompressIfNeeded(srcPath, tmpDir) {
  if (!isZstdFile(srcPath)) return { path: srcPath, tmp: null };
  const tmpOut = path.join(tmpDir, `decomp-${path.basename(srcPath)}`);
  execSync(`zstd -d "${srcPath}" -o "${tmpOut}" --force`);
  return { path: tmpOut, tmp: tmpOut };
}

// ---------------------------------------------------------------------------

async function main() {
  if (!apkgPath) {
    console.error('Usage: node ankiimport.js <file.apkg>');
    process.exit(1);
  }

  // Ensure output directories exist
  fs.mkdirSync(CARDS_PATH,  { recursive: true });
  fs.mkdirSync(IMAGES_PATH, { recursive: true });

  // Extract APKG (ZIP) to a temp directory
  console.log(`Extracting ${apkgPath} ...`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ankiimport-'));
  try {
    const zip = new AdmZip(apkgPath);
    zip.extractAllTo(tmpDir, /*overwrite=*/true);
  } catch (err) {
    console.error('Failed to extract APKG:', err.message);
    process.exit(1);
  }
  console.log(`Extracted to ${tmpDir}`);

  // Open Anki SQLite — prefer .anki21b (zstd-compressed, Anki ≥2.1.50),
  // then .anki21, then .anki2
  const anki21b = path.join(tmpDir, 'collection.anki21b');
  const anki21  = path.join(tmpDir, 'collection.anki21');
  const anki2   = path.join(tmpDir, 'collection.anki2');
  let ankiDbPath;
  if (fs.existsSync(anki21b)) {
    // Decompress in-place to a .anki21 file
    const decompressed = path.join(tmpDir, 'collection.anki21');
    console.log('Decompressing collection.anki21b ...');
    execSync(`zstd -d "${anki21b}" -o "${decompressed}" --force`);
    ankiDbPath = decompressed;
  } else if (fs.existsSync(anki21)) {
    ankiDbPath = anki21;
  } else if (fs.existsSync(anki2)) {
    ankiDbPath = anki2;
  } else {
    console.error('No collection database found in APKG.');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  }
  const ankiDb  = new Database(ankiDbPath, { readonly: true });
  const jdictDb = new Database(dbPath, { readonly: true });

  // Parse media map: {"0": "original_name.jpg", ...} → invert to name→key
  // In Anki ≥2.1.50 the media file is zstd-compressed; decompress if needed.
  const mediaPath = path.join(tmpDir, 'media');
  let nameToKey = {};
  if (fs.existsSync(mediaPath)) {
    try {
      let raw;
      const header = fs.readFileSync(mediaPath).slice(0, 4);
      const isZstd = header[0] === 0x28 && header[1] === 0xb5 && header[2] === 0x2f && header[3] === 0xfd;
      let decompressed;
      if (isZstd) {
        decompressed = execSync(`zstd -d "${mediaPath}" --stdout`);
      } else {
        decompressed = fs.readFileSync(mediaPath);
      }
      // Try JSON first (older Anki format), then protobuf (Anki ≥2.1.50)
      const text = decompressed.toString('utf8');
      if (text.trimStart().startsWith('{')) {
        const mediaMap = JSON.parse(text);
        nameToKey = Object.fromEntries(
          Object.entries(mediaMap).map(([k, v]) => [v, k])
        );
      } else {
        nameToKey = parseMediaProto(decompressed);
      }
      console.log(`Media map loaded: ${Object.keys(nameToKey).length} entries`);
    } catch (err) {
      console.warn('Warning: could not parse media map, images will be skipped:', err.message);
    }
  }

  // Prepared statement for exact Japanese word lookup
  const exactStmt = jdictDb.prepare(
    `SELECT seq FROM entries_text
     WHERE (' ' || kanji || ' ' LIKE ?) OR (' ' || kana || ' ' LIKE ?)
     LIMIT 1`
  );

  function lookupExact(word) {
    if (!word) return null;
    const padded = `% ${word} %`;
    return exactStmt.get(padded, padded)?.seq ?? null;
  }

  // Fetch all notes
  const allNotes = ankiDb.prepare('SELECT id, flds FROM notes').all();
  const notes = limit !== null ? allNotes.slice(0, limit) : allNotes;
  const total = notes.length;
  console.log(`${total} notes to process${limit !== null ? ` (limited from ${allNotes.length})` : ''}`);

  let countFound = 0, countCard = 0, countSkipped = 0, countError = 0;

  for (let i = 0; i < total; i++) {
    if (i % 500 === 0) process.stdout.write(`\r  ${i}/${total} ...`);

    const { id, flds } = notes[i];
    // Anki separates fields with ASCII unit separator 0x1f
    const parts = flds.split('\x1f');
    const [english = '', japanese = '', reading = '', story = '', picture = ''] = parts;

    const word = stripHtml(japanese).trim();
    if (!word) { countSkipped++; continue; }

    try {
      const seq = lookupExact(word);

      // --- Extract image (common to both cases) ---
      let savedImageFilename = null;
      const imgMatch = (picture || '').match(/src="([^"]+)"/);
      if (imgMatch) {
        const origName   = imgMatch[1];
        const numericKey = nameToKey[origName];
        if (numericKey !== undefined) {
          const srcPath = path.join(tmpDir, numericKey);
          if (fs.existsSync(srcPath)) {
            const origExt  = path.extname(origName).toLowerCase() || '.jpg';
            const SUPPORTED_IMAGE_EXTS = new Set(['.jpg','.jpeg','.png','.gif','.webp','.avif','.tiff','.tif']);
            if (SUPPORTED_IMAGE_EXTS.has(origExt)) {
              const { path: realSrc, tmp: tmpDecomp } = decompressIfNeeded(srcPath, tmpDir);
              const destName = `${uuidv4()}${origExt}`;
              const destPath = path.join(IMAGES_PATH, destName);
              try {
                await resizeImage(realSrc, destPath, MAX_IMAGE_BYTES);
                savedImageFilename = destName;
              } catch (imgErr) {
                // Unsupported or corrupt image — skip silently
              } finally {
                if (tmpDecomp) try { fs.unlinkSync(tmpDecomp); } catch (_) {}
              }
            }
          }
        }
      }

      if (seq !== null) {
        // ---------------------------------------------------------------
        // Case 1: found in dictionary — create or update wiki word page
        // ---------------------------------------------------------------
        countFound++;
        const slug = wiki.slugify(word);
        let page = await wiki.getWordPage(slug);

        if (!page) {
          page = { seq, word: slug, tags: [], contexts: [], image: '', notes: '' };
        }

        // Ensure "anki" tag
        if (!page.tags) page.tags = [];
        if (!page.tags.includes('anki')) page.tags.push('anki');

        // Set image only if not already set
        if (savedImageFilename && !page.image) {
          page.image = savedImageFilename;
        }

        // Append story under "# Example"
        const storyText = stripHtml(story).trim();
        if (storyText) {
          const notes = page.notes || '';
          if (notes.includes('# Example')) {
            // Append below the existing heading
            page.notes = notes.trimEnd() + '\n\n' + storyText + '\n';
          } else {
            page.notes = notes.trimEnd() + '\n\n# Example\n\n' + storyText + '\n';
          }
        }

        await wiki.saveWordPage(slug, page);

      } else {
        // ---------------------------------------------------------------
        // Case 2: not found in dictionary — write to wiki/cards/
        // ---------------------------------------------------------------
        const rawSlug = wiki.slugify(word || stripHtml(english) || `card-${id}`);
        // Guard against slug collisions from different words
        const slug = rawSlug || `card-${id}`;
        const cardPath = path.join(CARDS_PATH, `${slug}.md`);

        if (fs.existsSync(cardPath)) { countSkipped++; continue; }

        countCard++;
        const storyText = stripHtml(story).trim();
        const body = storyText ? `# Story\n\n${storyText}\n` : '';

        const frontmatter = {
          type:     'card',
          slug,
          english:  stripHtml(english).trim(),
          japanese: word,
          reading:  stripHtml(reading).trim(),
          image:    savedImageFilename || '',
        };

        const content = matter.stringify(body, frontmatter);
        fs.writeFileSync(cardPath, content, 'utf8');
      }

    } catch (err) {
      countError++;
      console.warn(`\n  Warning: note ${id} ("${word}"): ${err.message}`);
    }
  }

  process.stdout.write('\n');
  ankiDb.close();
  jdictDb.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(
    `Done. ${countFound} word pages updated/created, ` +
    `${countCard} card pages created, ` +
    `${countSkipped} skipped, ` +
    `${countError} errors.`
  );
}

main().catch(err => { console.error(err); process.exit(1); });
