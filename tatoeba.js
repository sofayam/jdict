/**
 * tatoeba.js — access layer for data/tatoeba.db
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data', 'tatoeba.db');

let _db = null;

function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH, { readonly: true });
  }
  return _db;
}

function dbExists() {
  return fs.existsSync(DB_PATH);
}

/**
 * Search for sentences containing `word`.
 * Returns { total, results } where each result has { jp_id, japanese, translations: [string] }.
 * Page is 1-based.
 */
function search(word, page = 1, limit = 20) {
  if (!dbExists()) return { total: 0, results: [] };

  const db = getDb();
  const pattern = `%${word}%`;
  const offset = (page - 1) * limit;

  const totalRow = db.prepare(
    'SELECT COUNT(DISTINCT jp_id) as n FROM sentences WHERE japanese LIKE ?'
  ).get(pattern);
  const total = totalRow ? totalRow.n : 0;

  if (total === 0) return { total: 0, results: [] };

  // Get the distinct jp_ids for this page
  const ids = db.prepare(
    'SELECT DISTINCT jp_id, japanese, reading FROM sentences WHERE japanese LIKE ? ORDER BY jp_id LIMIT ? OFFSET ?'
  ).all(pattern, limit, offset);

  if (ids.length === 0) return { total, results: [] };

  // Fetch all translations for those jp_ids in one query
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT jp_id, english FROM sentences WHERE jp_id IN (${placeholders}) ORDER BY jp_id, en_id`
  ).all(ids.map(r => r.jp_id));

  // Group translations by jp_id
  const translationMap = {};
  for (const row of rows) {
    if (!translationMap[row.jp_id]) translationMap[row.jp_id] = [];
    translationMap[row.jp_id].push(row.english);
  }

  const results = ids.map(r => ({
    jp_id: r.jp_id,
    japanese: r.japanese,
    reading: r.reading || null,
    translations: translationMap[r.jp_id] || [],
  }));

  return { total, results };
}

module.exports = { DB_PATH, dbExists, search };
