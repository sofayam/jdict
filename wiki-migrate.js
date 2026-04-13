/**
 * wiki-migrate.js -- One-time migration of file-based wiki to data/wiki.db.
 *
 * Reads wiki/words/*.md, wiki/cards/*.md, wiki/tags/*.md and inserts into SQLite.
 * File timestamps (birthtime/mtime) are preserved as created_at/updated_at.
 * Images are not touched.
 *
 * Usage:
 *   node wiki-migrate.js
 *   node wiki-migrate.js --dry-run   # count files only, no DB writes
 */

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const Database = require('better-sqlite3');
const args = require('minimist')(process.argv.slice(2));

const DRY_RUN = !!args['dry-run'];

const WIKI_PATH  = path.join(__dirname, 'wiki');
const WORDS_PATH = path.join(WIKI_PATH, 'words');
const CARDS_PATH = path.join(WIKI_PATH, 'cards');
const TAGS_PATH  = path.join(WIKI_PATH, 'tags');
const WIKI_DB_PATH = path.join(__dirname, 'data', 'wiki.db');

// Format a JS Date as a SQLite datetime string (UTC, no milliseconds)
function toSqlite(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function readMdFiles(dir) {
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────
// Count pass (always runs)
// ─────────────────────────────────────────────

const wordFiles = readMdFiles(WORDS_PATH);
const cardFiles = readMdFiles(CARDS_PATH);
const tagFiles  = readMdFiles(TAGS_PATH);

console.log(`Found: ${wordFiles.length} word pages, ${cardFiles.length} card pages, ${tagFiles.length} tag pages`);

if (DRY_RUN) {
  console.log('Dry run — exiting without writing.');
  process.exit(0);
}

if (fs.existsSync(WIKI_DB_PATH)) {
  console.error(`\ndata/wiki.db already exists. Remove it first if you want to re-migrate:\n  rm ${WIKI_DB_PATH}\n`);
  process.exit(1);
}

// ─────────────────────────────────────────────
// Create DB and schema
// ─────────────────────────────────────────────

fs.mkdirSync(path.dirname(WIKI_DB_PATH), { recursive: true });
const db = new Database(WIKI_DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE wiki_words (
    slug       TEXT PRIMARY KEY,
    seq        INTEGER,
    tags       TEXT NOT NULL DEFAULT '[]',
    image      TEXT,
    contexts   TEXT NOT NULL DEFAULT '[]',
    notes      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE wiki_cards (
    slug       TEXT PRIMARY KEY,
    english    TEXT NOT NULL DEFAULT '',
    japanese   TEXT NOT NULL DEFAULT '',
    reading    TEXT NOT NULL DEFAULT '',
    image      TEXT NOT NULL DEFAULT '',
    notes      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE wiki_tags (
    name       TEXT PRIMARY KEY,
    notes      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ─────────────────────────────────────────────
// Migrate words
// ─────────────────────────────────────────────

const insertWord = db.prepare(`
  INSERT INTO wiki_words (slug, seq, tags, image, contexts, notes, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const migrateWords = db.transaction(() => {
  let ok = 0, warn = 0;
  for (const file of wordFiles) {
    const slug = path.basename(file, '.md');
    const filePath = path.join(WORDS_PATH, file);
    try {
      const { data, content } = matter(fs.readFileSync(filePath, 'utf8'));
      const stat = fs.statSync(filePath);
      insertWord.run(
        slug,
        data.seq ?? null,
        JSON.stringify(Array.isArray(data.tags) ? data.tags : []),
        data.image || null,
        JSON.stringify(Array.isArray(data.contexts) ? data.contexts : []),
        content.trim(),
        toSqlite(stat.birthtime),
        toSqlite(stat.mtime)
      );
      ok++;
    } catch (err) {
      console.warn(`  WARN word ${slug}: ${err.message}`);
      warn++;
    }
  }
  return { ok, warn };
});

const wordResult = migrateWords();
console.log(`Words:  ${wordResult.ok} inserted, ${wordResult.warn} warnings`);

// ─────────────────────────────────────────────
// Migrate cards
// ─────────────────────────────────────────────

const insertCard = db.prepare(`
  INSERT INTO wiki_cards (slug, english, japanese, reading, image, notes, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const migrateCards = db.transaction(() => {
  let ok = 0, warn = 0;
  for (const file of cardFiles) {
    const slug = path.basename(file, '.md');
    const filePath = path.join(CARDS_PATH, file);
    try {
      const { data, content } = matter(fs.readFileSync(filePath, 'utf8'));
      const stat = fs.statSync(filePath);
      insertCard.run(
        slug,
        data.english  || '',
        data.japanese || '',
        data.reading  || '',
        data.image    || '',
        content.trim(),
        toSqlite(stat.birthtime)
      );
      ok++;
    } catch (err) {
      console.warn(`  WARN card ${slug}: ${err.message}`);
      warn++;
    }
  }
  return { ok, warn };
});

const cardResult = migrateCards();
console.log(`Cards:  ${cardResult.ok} inserted, ${cardResult.warn} warnings`);

// ─────────────────────────────────────────────
// Migrate tags
// ─────────────────────────────────────────────

const insertTag = db.prepare(`
  INSERT INTO wiki_tags (name, notes, created_at, updated_at)
  VALUES (?, ?, ?, ?)
`);

const migrateTags = db.transaction(() => {
  let ok = 0, warn = 0;
  for (const file of tagFiles) {
    const name = path.basename(file, '.md');
    const filePath = path.join(TAGS_PATH, file);
    try {
      const { content } = matter(fs.readFileSync(filePath, 'utf8'));
      const stat = fs.statSync(filePath);
      insertTag.run(name, content.trim(), toSqlite(stat.birthtime), toSqlite(stat.mtime));
      ok++;
    } catch (err) {
      console.warn(`  WARN tag ${name}: ${err.message}`);
      warn++;
    }
  }
  return { ok, warn };
});

const tagResult = migrateTags();
console.log(`Tags:   ${tagResult.ok} inserted, ${tagResult.warn} warnings`);

db.close();
console.log(`\nMigration complete → ${WIKI_DB_PATH}`);
console.log(`\nVerify things look right, then you can remove the old files:`);
console.log(`  rm -r wiki/words wiki/cards wiki/tags`);
