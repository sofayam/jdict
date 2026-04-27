/**
 * kanjiimporter.js — Import KANJIDIC2 and KRADFILE into jdict.db.
 *
 * Usage:
 *     node kanjiimporter.js
 *     node kanjiimporter.js --db data/jdict.db --kanjidic data/kanjidic2.xml --kradfile data/kradfile
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { XMLParser } = require('fast-xml-parser');
const minimist = require('minimist');

const args = minimist(process.argv.slice(2));
const dbPath      = args.db       || 'data/jdict.db';
const kanjidicPath = args.kanjidic || 'sources/kanjidic2.xml';
const kradfilePath = args.kradfile || 'sources/kradfile';

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kanji (
      literal       TEXT PRIMARY KEY,
      grade         INTEGER,
      stroke_count  INTEGER,
      freq          INTEGER,
      jlpt          INTEGER,
      on_json       TEXT,
      kun_json      TEXT,
      meanings_json TEXT
    );

    CREATE TABLE IF NOT EXISTS kanji_components (
      kanji           TEXT PRIMARY KEY,
      components_json TEXT
    );
  `);
}

function importKanjidic(db, xmlPath) {
  console.log(`Reading ${xmlPath} ...`);
  const t0 = Date.now();

  let raw = fs.readFileSync(xmlPath);

  // Strip DOCTYPE block (same approach as importer.js)
  const doctypeEnd = raw.indexOf(']>');
  if (doctypeEnd !== -1) {
    const xmlDeclEnd = raw.indexOf('?>');
    if (xmlDeclEnd !== -1) {
      const header = raw.slice(0, xmlDeclEnd + 2);
      const body = raw.slice(doctypeEnd + 2);
      raw = Buffer.concat([header, body]);
    } else {
      raw = raw.slice(doctypeEnd + 2);
    }
  }

  console.log('Parsing XML ...');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => ['character', 'cp_value', 'rad_value', 'reading', 'meaning', 'nanori', 'stroke_count'].includes(name),
  });
  const root = parser.parse(raw.toString('utf8'));
  const characters = root.kanjidic2.character || [];
  console.log(`Found ${characters.length} characters. Importing ...`);

  const insert = db.prepare(
    'INSERT OR REPLACE INTO kanji(literal, grade, stroke_count, freq, jlpt, on_json, kun_json, meanings_json) VALUES (?,?,?,?,?,?,?,?)'
  );

  let total = 0;
  db.transaction(() => {
    for (const ch of characters) {
      const literal = ch.literal || '';
      if (!literal) continue;

      const misc = ch.misc || {};
      const grade       = parseInt(misc.grade) || null;
      const strokeCount = parseInt([].concat(misc.stroke_count || [])[0]) || null;
      const freq        = parseInt(misc.freq) || null;
      const jlpt        = parseInt(misc.jlpt) || null;

      const rmgroup = ch.reading_meaning?.rmgroup || {};
      const readings = [].concat(rmgroup.reading || []);
      const meanings = [].concat(rmgroup.meaning || []);

      const onReadings  = readings.filter(r => r['@_r_type'] === 'ja_on').map(r => r['#text'] || r);
      const kunReadings = readings.filter(r => r['@_r_type'] === 'ja_kun').map(r => r['#text'] || r);
      // English meanings have no m_lang attribute (or m_lang absent)
      const engMeanings = meanings
        .filter(m => typeof m === 'string' || !m['@_m_lang'])
        .map(m => typeof m === 'string' ? m : (m['#text'] || ''))
        .filter(Boolean);

      insert.run(
        literal,
        grade,
        strokeCount,
        freq,
        jlpt,
        JSON.stringify(onReadings),
        JSON.stringify(kunReadings),
        JSON.stringify(engMeanings)
      );

      total++;
      if (total % 2000 === 0) process.stdout.write(`  ... ${total.toLocaleString()} kanji imported\r`);
    }
  })();

  console.log(`\nKANJIDIC2: ${total.toLocaleString()} entries in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

function importKradfile(db, kradPath) {
  console.log(`Reading ${kradPath} ...`);
  const t0 = Date.now();

  const buf = fs.readFileSync(kradPath);
  const text = new TextDecoder('euc-jp').decode(buf);
  const lines = text.split('\n').filter(l => l.trim() && !l.startsWith('#'));

  const insert = db.prepare(
    'INSERT OR REPLACE INTO kanji_components(kanji, components_json) VALUES (?,?)'
  );

  let total = 0;
  db.transaction(() => {
    for (const line of lines) {
      const colonIdx = line.indexOf(' : ');
      if (colonIdx === -1) continue;
      const kanji = line.slice(0, colonIdx).trim();
      const components = line.slice(colonIdx + 3).trim().split(' ').filter(Boolean);
      if (!kanji || components.length === 0) continue;
      insert.run(kanji, JSON.stringify(components));
      total++;
    }
  })();

  console.log(`KRADFILE: ${total.toLocaleString()} entries in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// --- main ---

for (const [label, p] of [['DB', dbPath], ['KANJIDIC2', kanjidicPath], ['KRADFILE', kradfilePath]]) {
  if (!fs.existsSync(p)) {
    console.error(`ERROR: ${label} file not found: ${p}`);
    process.exit(1);
  }
}

const db = new Database(dbPath);

createSchema(db);
importKanjidic(db, kanjidicPath);
importKradfile(db, kradfilePath);

console.log('Building indexes ...');
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_kanji_jlpt  ON kanji(jlpt);
  CREATE INDEX IF NOT EXISTS idx_kanji_grade ON kanji(grade);
`);

db.close();
console.log('Done.');
