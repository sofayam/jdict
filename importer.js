/**
 * importer.js — Convert JMdict XML to a SQLite database.
 * 
 * Usage:
 *     node importer.js --xml data/JMdict --db data/jdict.db
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { XMLParser } = require('fast-xml-parser');

function stripEntity(text) {
  if (typeof text !== 'string') return '';
  if (text.startsWith('&') && text.endsWith(';')) {
    return text.slice(1, -1);
  }
  return text;
}

function createSchema(db) {
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;

    CREATE TABLE IF NOT EXISTS entries (
      seq         INTEGER PRIMARY KEY,
      kanji_json  TEXT,
      kana_json   TEXT,
      senses_json TEXT,
      jlpt        TEXT
    );

    CREATE TABLE IF NOT EXISTS entries_text (
      seq     INTEGER PRIMARY KEY,
      kanji   TEXT NOT NULL DEFAULT '',
      kana    TEXT NOT NULL DEFAULT '',
      glosses TEXT NOT NULL DEFAULT ''
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
      glosses,
      content='entries_text',
      content_rowid='seq'
    );
  `);
}

function parseEntry(entry) {
  const seq = parseInt(entry.ent_seq, 10) || 0;

  const kanjiList = [].concat(entry.k_ele || []).map(k => ({
    keb: k.keb || '',
    ke_inf: [].concat(k.ke_inf || []).map(stripEntity),
    ke_pri: [].concat(k.ke_pri || []),
  }));

  const kanaList = [].concat(entry.r_ele || []).map(r => ({
    reb: r.reb || '',
    re_nokanji: r.re_nokanji !== undefined,
    re_inf: [].concat(r.re_inf || []).map(stripEntity),
    re_pri: [].concat(r.re_pri || []),
    re_restr: [].concat(r.re_restr || []),
  }));

  const senses = [].concat(entry.sense || []).map(s => {
    const lsource = [].concat(s.lsource || []).map(ls => ({
      lang: ls['@_xml:lang'] || 'eng',
      text: ls['#text'] || ls || '',
      ls_type: ls['@_ls_type'] || '',
      ls_wasei: ls['@_ls_wasei'] || '',
    }));

    const glosses = [].concat(s.gloss || []).map(g => {
      let text, lang, g_type;
      if (typeof g === 'object') {
        text = g['#text'] || '';
        lang = g['@_xml:lang'] || 'eng';
        g_type = g['@_g_type'] || '';
      } else {
        text = g || '';
        lang = 'eng';
        g_type = '';
      }
      return { lang, text, g_type };
    });

    return {
      pos: [].concat(s.pos || []).map(stripEntity),
      misc: [].concat(s.misc || []).map(stripEntity),
      field: [].concat(s.field || []).map(stripEntity),
      dial: [].concat(s.dial || []).map(stripEntity),
      stagk: [].concat(s.stagk || []),
      stagr: [].concat(s.stagr || []),
      xref: [].concat(s.xref || []),
      ant: [].concat(s.ant || []),
      lsource,
      glosses,
      s_inf: [].concat(s.s_inf || []),
    };
  });

  return { seq, kanji: kanjiList, kana: kanaList, senses };
}

function importJmdict(xmlPath, dbPath) {
  console.log(`Opening ${xmlPath} ...`);
  const t0 = Date.now();

  const db = new Database(dbPath);
  createSchema(db);

  console.log("Reading XML (stripping DOCTYPE entities) ...");
  let raw = fs.readFileSync(xmlPath);

  // Strip DOCTYPE block (similar to Python logic)
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

  // Replace XML entity refs (&v1; etc.) with their names as plain text
  let rawStr = raw.toString('utf8');
  rawStr = rawStr.replace(/&([A-Za-z0-9_-]+);/g, '$1');

  console.log("Parsing XML ...");
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    allowBooleanAttributes: true,
  });
  const root = parser.parse(rawStr);

  const entries = root.JMdict.entry || [];
  console.log(`Found ${entries.length} entries. Importing...`);

  const insertEntry = db.prepare('INSERT OR REPLACE INTO entries VALUES (?,?,?,?,?)');
  const insertText = db.prepare('INSERT OR REPLACE INTO entries_text VALUES (?,?,?,?)');
  const insertFts = db.prepare('INSERT INTO entries_fts(rowid, glosses) VALUES (?,?)');

  const batchSize = 5000;
  let total = 0;

  db.transaction(() => {
    for (const entryObj of entries) {
      const e = parseEntry(entryObj);

      const kanjiText = e.kanji.map(k => k.keb).join(' ');
      const kanaText = e.kana.map(k => k.reb).join(' ');
      const glossText = e.senses
        .flatMap(s => s.glosses)
        .filter(g => g.lang === 'eng')
        .map(g => g.text)
        .join(' ');

      insertEntry.run(
        e.seq,
        JSON.stringify(e.kanji),
        JSON.stringify(e.kana),
        JSON.stringify(e.senses),
        null // jlpt
      );
      insertText.run(e.seq, kanjiText, kanaText, glossText);
      insertFts.run(e.seq, glossText);

      total++;
      if (total % batchSize === 0) {
        process.stdout.write(`  ... ${total.toLocaleString()} entries imported\r`);
      }
    }
  })();

  console.log("\nBuilding indexes ...");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_text_kanji ON entries_text(kanji);
    CREATE INDEX IF NOT EXISTS idx_text_kana  ON entries_text(kana);
  `);

  console.log(`Done. ${total.toLocaleString()} entries imported in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${dbPath}`);
  db.close();
}

const args = require('minimist')(process.argv.slice(2));
const xmlPath = args.xml || 'data/JMdict';
const dbPath = args.db || 'data/jdict.db';

if (!fs.existsSync(xmlPath)) {
  console.error(`ERROR: XML file not found: ${xmlPath}`);
  process.exit(1);
}

if (!fs.existsSync(path.dirname(dbPath))) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

importJmdict(xmlPath, dbPath);
