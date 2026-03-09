/**
 * db.js -- Database access layer for jdict-service.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data', 'jdict.db');

let _db = null;

function getDb() {
  if (!_db) {
    if (!fs.existsSync(path.dirname(DB_PATH))) {
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    }
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
  }
  return _db;
}

function dbExists() {
  return fs.existsSync(DB_PATH);
}

function _rowToEntry(row) {
  if (!row) return null;
  return {
    seq: row.seq,
    kanji: JSON.parse(row.kanji_json || '[]'),
    kana: JSON.parse(row.kana_json || '[]'),
    senses: JSON.parse(row.senses_json || '[]'),
    jlpt: row.jlpt,
  };
}

function _isJapanese(q) {
  /** True if the string contains any CJK / kana codepoints. */
  for (let i = 0; i < q.length; i++) {
    const cp = q.charCodeAt(i);
    if (
      (cp >= 0x3040 && cp <= 0x30ff) || // Hiragana + Katakana
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified (common)
      (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility
      (cp >= 0xff65 && cp <= 0xff9f)    // Halfwidth Katakana
    ) {
      return true;
    }
  }
  return false;
}

function search(q, lang = 'eng', limit = 20, offset = 0) {
  /** Search by kanji, kana, or English gloss. */
  q = q.trim();
  if (!q) {
    return [];
  }

  const db = getDb();
  let rows;

  if (_isJapanese(q)) {
    const exactPattern = `% ${q} %`;
    // Try exact word match in the space-separated list first
    // We pad with spaces to ensure we match the full word
    rows = db.prepare(`
      SELECT e.seq, e.kanji_json, e.kana_json, e.senses_json, e.jlpt
      FROM entries e
      JOIN entries_text t ON t.seq = e.seq
      WHERE (' ' || t.kanji || ' ' LIKE ?) OR (' ' || t.kana || ' ' LIKE ?)
      LIMIT ? OFFSET ?
    `).all(exactPattern, exactPattern, limit, offset);

    if (rows.length === 0) {
      // Fallback: Substring match on the plain-text entries_text table
      rows = db.prepare(`
        SELECT e.seq, e.kanji_json, e.kana_json, e.senses_json, e.jlpt
        FROM entries e
        JOIN entries_text t ON t.seq = e.seq
        WHERE t.kanji LIKE ? OR t.kana LIKE ?
        LIMIT ? OFFSET ?
      `).all(`%${q}%`, `%${q}%`, limit, offset);
    }
  } else {
    // FTS5 full-text search on English glosses
    // We try exact matches first for higher precision
    const exactQuery = q.split(/\s+/)
      .filter(Boolean)
      .map(word => `"${word.replace(/"/g, '')}"`)
      .join(' ');
    
    const prefixQuery = q.split(/\s+/)
      .filter(Boolean)
      .map(word => `"${word.replace(/"/g, '')}"*`)
      .join(' ');

    try {
      // Try exact match first
      let ftsRows = db.prepare(`
        SELECT rowid FROM entries_fts 
        WHERE entries_fts MATCH ? 
        ORDER BY rank 
        LIMIT ? OFFSET ?
      `).all(exactQuery, limit, offset);

      // If no exact matches, try prefix matching
      if (ftsRows.length === 0) {
        ftsRows = db.prepare(`
          SELECT rowid FROM entries_fts 
          WHERE entries_fts MATCH ? 
          ORDER BY rank 
          LIMIT ? OFFSET ?
        `).all(prefixQuery, limit, offset);
      }
      
      const seqs = ftsRows.map(r => r.rowid);
      if (seqs.length === 0) {
        return [];
      }
      
      const placeholders = seqs.map(() => '?').join(',');
      rows = db.prepare(`
        SELECT seq, kanji_json, kana_json, senses_json, jlpt 
        FROM entries 
        WHERE seq IN (${placeholders})
      `).all(...seqs);
    } catch (err) {
      // Fallback: LIKE on the gloss text column
      rows = db.prepare(`
        SELECT e.seq, e.kanji_json, e.kana_json, e.senses_json, e.jlpt
        FROM entries e
        JOIN entries_text t ON t.seq = e.seq
        WHERE t.glosses LIKE ?
        LIMIT ? OFFSET ?
      `).all(`%${q}%`, limit, offset);
    }
  }

  return rows.map(_rowToEntry);
}

function getEntry(seq) {
  const row = getDb().prepare(
    'SELECT seq, kanji_json, kana_json, senses_json, jlpt FROM entries WHERE seq = ?'
  ).get(seq);
  return _rowToEntry(row);
}

function getByJlpt(level, limit = 50, offset = 0) {
  const rows = getDb().prepare(
    'SELECT seq, kanji_json, kana_json, senses_json, jlpt FROM entries WHERE jlpt = ? LIMIT ? OFFSET ?'
  ).all(level.toUpperCase(), limit, offset);
  return rows.map(_rowToEntry);
}

function randomEntries(n = 5) {
  const rows = getDb().prepare(
    'SELECT seq, kanji_json, kana_json, senses_json, jlpt FROM entries ORDER BY RANDOM() LIMIT ?'
  ).all(n);
  return rows.map(_rowToEntry);
}

function entryCount() {
  const row = getDb().prepare('SELECT COUNT(*) as c FROM entries').get();
  return row ? row.c : 0;
}

module.exports = {
  DB_PATH,
  dbExists,
  search,
  getEntry,
  getByJlpt,
  randomEntries,
  entryCount,
};
