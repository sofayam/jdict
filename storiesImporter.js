/**
 * storiesImporter.js — Import kanji mnemonic stories into jdict.db.
 *
 * Source: sources/kanji-stories.csv (semicolon-delimited, no header row)
 * Fields: kanji; keyword; heisig_story; heisig_comment; koohi_1..5
 *
 * Usage:
 *     node storiesImporter.js
 *     node storiesImporter.js --db data/jdict.db --csv sources/kanji-stories.csv
 */

const fs = require('fs');
const Database = require('better-sqlite3');
const minimist = require('minimist');

const args = minimist(process.argv.slice(2));
const dbPath  = args.db  || 'data/jdict.db';
const csvPath = args.csv || 'sources/kanji-stories.csv';

for (const [label, p] of [['DB', dbPath], ['CSV', csvPath]]) {
  if (!fs.existsSync(p)) { console.error(`ERROR: ${label} not found: ${p}`); process.exit(1); }
}

function strip(text) {
  if (!text || !text.trim()) return null;
  let t = text.trim();
  // Remove Koohi story prefix: "N) [[username](url)] DD-M-YYYY(votes): "
  t = t.replace(/^\d+\)\s+\S+\s+[\d-]+\(\d+\):\s*/, '');
  // Strip markdown links [[text](url)] and [text](url)
  t = t.replace(/\[?\[([^\]]+)\]\([^)]*\)\]?/g, '$1');
  // Strip bold **text** and italic *text* / _text_
  t = t.replace(/\*\*([^*]*)\*\*/g, '$1');
  t = t.replace(/\*([^*]+)\*/g, '$1');
  t = t.replace(/_([^_]+)_/g, '$1');
  // Strip angle-bracket URLs/tags like <http://...>
  t = t.replace(/<[^>]+>/g, '');
  // Normalize whitespace
  t = t.replace(/\s+/g, ' ').trim();
  return t || null;
}

const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS kanji_stories (
    literal        TEXT PRIMARY KEY,
    keyword        TEXT,
    heisig_story   TEXT,
    heisig_comment TEXT,
    koohi_1        TEXT,
    koohi_2        TEXT,
    koohi_3        TEXT,
    koohi_4        TEXT,
    koohi_5        TEXT
  )
`);

const insert = db.prepare(`
  INSERT OR REPLACE INTO kanji_stories
    (literal, keyword, heisig_story, heisig_comment, koohi_1, koohi_2, koohi_3, koohi_4, koohi_5)
  VALUES (?,?,?,?,?,?,?,?,?)
`);

const lines = fs.readFileSync(csvPath, 'utf8').split('\n');
let total = 0;

db.transaction(() => {
  for (const line of lines) {
    if (!line.trim()) continue;
    const fields = line.split(';');
    const literal = fields[0]?.trim();
    if (!literal) continue;
    insert.run(
      literal,
      strip(fields[1]),
      strip(fields[2]),
      strip(fields[3]),
      strip(fields[4]),
      strip(fields[5]),
      strip(fields[6]),
      strip(fields[7]),
      strip(fields[8])
    );
    total++;
  }
})();

db.close();
console.log(`Imported ${total} kanji stories.`);
