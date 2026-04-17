#!/usr/bin/env node
/**
 * tatoebaImporter.js — imports Tatoeba Japanese–English sentence pairs into data/tatoeba.db
 *
 * Sources:
 *   sources/tatoeba/sentences260417.tsv   — jp_id, japanese, en_id, english
 *   sources/tatoeba/jpn_transcriptions.tsv — jp_id, jpn, Hrkt, username, reading
 *
 * Usage:
 *   node tatoebaImporter.js
 *   node tatoebaImporter.js --tsv path/to/sentences.tsv --readings path/to/transcriptions.tsv --db path/to/tatoeba.db
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const args = process.argv.slice(2);
function getArg(flag, def) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}

const TSV_PATH      = getArg('--tsv',      path.join(__dirname, 'sources', 'tatoeba', 'sentences260417.tsv'));
const READING_PATH  = getArg('--readings', path.join(__dirname, 'sources', 'tatoeba', 'jpn_transcriptions.tsv'));
const DB_PATH       = getArg('--db',       path.join(__dirname, 'data', 'tatoeba.db'));

if (!fs.existsSync(TSV_PATH)) { console.error(`TSV not found: ${TSV_PATH}`); process.exit(1); }
if (fs.existsSync(DB_PATH))   { console.error(`DB already exists: ${DB_PATH} — delete it first.`); process.exit(1); }

// ── Phase 1: load readings into a Map ────────────────────────────────────────

const readings = new Map();
if (fs.existsSync(READING_PATH)) {
  console.log(`Loading readings: ${READING_PATH}`);
  const lines = fs.readFileSync(READING_PATH, 'utf8').split('\n');
  for (const line of lines) {
    const clean = line.replace(/^\uFEFF/, '');
    const parts = clean.split('\t');
    if (parts.length < 5) continue;
    const id = parseInt(parts[0], 10);
    const reading = parts[4];
    if (id && reading) readings.set(id, reading);
  }
  console.log(`  ${readings.size.toLocaleString()} readings loaded.`);
} else {
  console.warn(`Readings file not found (${READING_PATH}) — importing without readings.`);
}

// ── Phase 2: import sentences ─────────────────────────────────────────────────

console.log(`Reading: ${TSV_PATH}`);
console.log(`Writing: ${DB_PATH}`);

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE sentences (
    jp_id   INTEGER NOT NULL,
    japanese TEXT    NOT NULL,
    en_id   INTEGER NOT NULL,
    english TEXT    NOT NULL,
    reading TEXT
  );
  CREATE INDEX idx_japanese ON sentences (japanese);
  CREATE INDEX idx_jp_id    ON sentences (jp_id);
`);

const insert = db.prepare(
  'INSERT INTO sentences (jp_id, japanese, en_id, english, reading) VALUES (?, ?, ?, ?, ?)'
);
const insertMany = db.transaction((rows) => {
  for (const r of rows) insert.run(r.jp_id, r.japanese, r.en_id, r.english, r.reading);
});

const rl = readline.createInterface({ input: fs.createReadStream(TSV_PATH), crlfDelay: Infinity });

let batch = [];
const BATCH_SIZE = 5000;
let total = 0;
let skipped = 0;

rl.on('line', (line) => {
  const clean = line.replace(/^\uFEFF/, '');
  const parts = clean.split('\t');
  if (parts.length !== 4) { skipped++; return; }
  const [jp_id_s, japanese, en_id_s, english] = parts;
  if (!jp_id_s || !japanese || !en_id_s || !english) { skipped++; return; }
  const jp_id = parseInt(jp_id_s, 10);
  batch.push({ jp_id, japanese, en_id: parseInt(en_id_s, 10), english, reading: readings.get(jp_id) || null });
  if (batch.length >= BATCH_SIZE) {
    insertMany(batch);
    total += batch.length;
    batch = [];
    process.stdout.write(`\r  ${total.toLocaleString()} rows inserted…`);
  }
});

rl.on('close', () => {
  if (batch.length) { insertMany(batch); total += batch.length; }
  db.close();
  console.log(`\nDone. ${total.toLocaleString()} rows inserted, ${skipped} skipped.`);
  console.log(`Database: ${DB_PATH}`);
});
