#!/usr/bin/env node
/**
 * tatoebaAddReadings.js — adds a `reading` column to data/tatoeba.db and
 * populates it from sources/tatoeba/jpn_transcriptions.tsv.
 *
 * Safe to run on an existing tatoeba.db — skips the column creation if it
 * already exists. Re-running overwrites existing reading values.
 *
 * Usage:
 *   node tatoebaAddReadings.js
 *   node tatoebaAddReadings.js --tsv path/to/jpn_transcriptions.tsv --db path/to/tatoeba.db
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

const TSV_PATH = getArg('--tsv', path.join(__dirname, 'sources', 'tatoeba', 'jpn_transcriptions.tsv'));
const DB_PATH  = getArg('--db',  path.join(__dirname, 'data', 'tatoeba.db'));

if (!fs.existsSync(TSV_PATH)) { console.error(`TSV not found: ${TSV_PATH}`); process.exit(1); }
if (!fs.existsSync(DB_PATH))  { console.error(`DB not found: ${DB_PATH} — run tatoebaImporter.js first`); process.exit(1); }

const db = new Database(DB_PATH);

// Add column if absent
const cols = db.prepare("PRAGMA table_info(sentences)").all().map(c => c.name);
if (!cols.includes('reading')) {
  db.exec('ALTER TABLE sentences ADD COLUMN reading TEXT');
  console.log('Added `reading` column to sentences table.');
} else {
  console.log('`reading` column already exists — values will be overwritten.');
}

const update = db.prepare('UPDATE sentences SET reading = ? WHERE jp_id = ?');

const updateBatch = db.transaction((rows) => {
  for (const r of rows) update.run(r.reading, r.jp_id);
});

const rl = readline.createInterface({ input: fs.createReadStream(TSV_PATH), crlfDelay: Infinity });

let batch = [];
const BATCH_SIZE = 5000;
let total = 0;
let skipped = 0;

rl.on('line', (line) => {
  const clean = line.replace(/^\uFEFF/, '');
  const parts = clean.split('\t');
  // Expected: jp_id, lang, script, username, transcription
  if (parts.length < 5) { skipped++; return; }
  const jp_id = parseInt(parts[0], 10);
  const reading = parts[4];
  if (!jp_id || !reading) { skipped++; return; }
  batch.push({ jp_id, reading });
  if (batch.length >= BATCH_SIZE) {
    updateBatch(batch);
    total += batch.length;
    batch = [];
    process.stdout.write(`\r  ${total.toLocaleString()} readings applied…`);
  }
});

rl.on('close', () => {
  if (batch.length) {
    updateBatch(batch);
    total += batch.length;
  }
  db.close();
  console.log(`\nDone. ${total.toLocaleString()} readings applied, ${skipped} skipped.`);
});
