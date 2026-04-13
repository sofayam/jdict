/**
 * wiki.js -- Data access layer for the wiki (SQLite-backed).
 *
 * All functions are synchronous (better-sqlite3).
 * Images remain on disk under wiki/images/ — everything else lives in data/wiki.db.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const WIKI_DB_PATH = path.join(__dirname, 'data', 'wiki.db');

let _db = null;

function getWikiDb() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(WIKI_DB_PATH), { recursive: true });
  _db = new Database(WIKI_DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS wiki_words (
      slug       TEXT PRIMARY KEY,
      seq        INTEGER,
      tags       TEXT NOT NULL DEFAULT '[]',
      image      TEXT,
      contexts   TEXT NOT NULL DEFAULT '[]',
      notes      TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS wiki_cards (
      slug       TEXT PRIMARY KEY,
      english    TEXT NOT NULL DEFAULT '',
      japanese   TEXT NOT NULL DEFAULT '',
      reading    TEXT NOT NULL DEFAULT '',
      image      TEXT NOT NULL DEFAULT '',
      notes      TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS wiki_tags (
      name       TEXT PRIMARY KEY,
      notes      TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return _db;
}

// ─────────────────────────────────────────────
// Slug utility
// ─────────────────────────────────────────────

function slugify(text) {
  return text
    .toString()
    .trim()
    .replace(/[\s\/\?#%&]+/g, '-')
    .replace(/[^a-zA-Z0-9\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\uFF00-\uFFEF\u4E00-\u9FAF\u3400-\u4DBF-]+/g, '')
    .replace(/--+/g, '-');
}

// ─────────────────────────────────────────────
// Word pages
// ─────────────────────────────────────────────

function getWordPage(slug) {
  const row = getWikiDb().prepare('SELECT * FROM wiki_words WHERE slug = ?').get(slug);
  if (!row) return null;
  return {
    word: row.slug,
    seq: row.seq,
    tags: JSON.parse(row.tags),
    image: row.image || '',
    contexts: JSON.parse(row.contexts),
    notes: row.notes || '',
  };
}

function wordExists(slug) {
  return !!getWikiDb().prepare('SELECT 1 FROM wiki_words WHERE slug = ?').get(slug);
}

function saveWordPage(slug, pageData) {
  const db = getWikiDb();
  const { notes, tags, contexts, seq, image } = pageData;

  if (Array.isArray(tags) && tags.length > 0) {
    const insertTag = db.prepare('INSERT OR IGNORE INTO wiki_tags (name) VALUES (?)');
    for (const tag of tags) insertTag.run(tag);
  }

  db.prepare(`
    INSERT INTO wiki_words (slug, seq, tags, image, contexts, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(slug) DO UPDATE SET
      seq        = excluded.seq,
      tags       = excluded.tags,
      image      = excluded.image,
      contexts   = excluded.contexts,
      notes      = excluded.notes,
      updated_at = datetime('now')
  `).run(
    slug,
    seq ?? null,
    JSON.stringify(tags || []),
    image || null,
    JSON.stringify(contexts || []),
    notes || ''
  );
}

// ─────────────────────────────────────────────
// Tag pages
// ─────────────────────────────────────────────

function getAllTags() {
  return getWikiDb().prepare('SELECT name FROM wiki_tags ORDER BY name').all().map(r => r.name);
}

function getTagPage(tagName) {
  const row = getWikiDb().prepare('SELECT * FROM wiki_tags WHERE name = ?').get(tagName);
  if (!row) return null;
  return { name: row.name, notes: row.notes || '' };
}

function getWordsForTag(tagName) {
  return getWikiDb().prepare(`
    SELECT slug FROM wiki_words
    WHERE EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)
    ORDER BY slug
  `).all(tagName).map(r => ({ name: r.slug }));
}

function saveTagPage(tagName, pageData) {
  getWikiDb().prepare(`
    INSERT INTO wiki_tags (name, notes, created_at, updated_at)
    VALUES (?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(name) DO UPDATE SET
      notes      = excluded.notes,
      updated_at = datetime('now')
  `).run(tagName, pageData.notes || '');
}

// ─────────────────────────────────────────────
// Card pages
// ─────────────────────────────────────────────

function getCardPage(slug) {
  const row = getWikiDb().prepare('SELECT * FROM wiki_cards WHERE slug = ?').get(slug);
  if (!row) return null;
  return {
    type: 'card',
    slug: row.slug,
    english: row.english,
    japanese: row.japanese,
    reading: row.reading,
    image: row.image,
    notes: row.notes,
  };
}

// ─────────────────────────────────────────────
// Index / browse queries
// ─────────────────────────────────────────────

function getWikiIndexData() {
  const db = getWikiDb();
  return {
    wordsByModified: db.prepare('SELECT slug as name, updated_at as mtime, created_at as birthtime FROM wiki_words ORDER BY updated_at DESC LIMIT 20').all(),
    wordsByCreated:  db.prepare('SELECT slug as name, updated_at as mtime, created_at as birthtime FROM wiki_words ORDER BY created_at DESC LIMIT 20').all(),
    tagsByModified:  db.prepare('SELECT name, updated_at as mtime, created_at as birthtime FROM wiki_tags ORDER BY updated_at DESC LIMIT 20').all(),
    tagsByCreated:   db.prepare('SELECT name, updated_at as mtime, created_at as birthtime FROM wiki_tags ORDER BY created_at DESC LIMIT 20').all(),
  };
}

function getWikiBrowseData() {
  const db = getWikiDb();

  const allWords = db.prepare('SELECT slug FROM wiki_words').all()
    .map(r => r.slug)
    .sort((a, b) => a.localeCompare(b, 'ja'));

  const tags = db.prepare(`
    SELECT tag.value as name, COUNT(*) as count
    FROM wiki_words, json_each(tags) as tag
    GROUP BY tag.value
    ORDER BY count DESC
  `).all();

  const ctxRows = db.prepare(`
    SELECT w.slug, ctx.value as ctx_json
    FROM wiki_words w, json_each(w.contexts) as ctx
    WHERE json_extract(ctx.value, '$.podcast') IS NOT NULL
  `).all();

  const episodeMap = {};
  const seenPerWord = {};
  let earliest = '';
  let latest = '';

  for (const row of ctxRows) {
    const ctx = JSON.parse(row.ctx_json);
    if (!ctx.podcast || !ctx.episode) continue;
    const key = `${ctx.podcast}\x00${ctx.episode}`;
    if (!seenPerWord[row.slug]) seenPerWord[row.slug] = new Set();
    if (seenPerWord[row.slug].has(key)) continue;
    seenPerWord[row.slug].add(key);

    if (!episodeMap[key]) {
      episodeMap[key] = { podcast: ctx.podcast, episode: ctx.episode, latestTimestamp: '', words: [] };
    }
    episodeMap[key].words.push(row.slug);
    if ((ctx.timestamp || '') > episodeMap[key].latestTimestamp) {
      episodeMap[key].latestTimestamp = ctx.timestamp || '';
    }
    if (ctx.timestamp) {
      if (!earliest || ctx.timestamp < earliest) earliest = ctx.timestamp;
      if (!latest   || ctx.timestamp > latest)   latest   = ctx.timestamp;
    }
  }

  const podcastMap = {};
  for (const ep of Object.values(episodeMap)) {
    if (!podcastMap[ep.podcast]) {
      podcastMap[ep.podcast] = { name: ep.podcast, episodes: [], wordSet: new Set() };
    }
    podcastMap[ep.podcast].episodes.push(ep);
    for (const w of ep.words) podcastMap[ep.podcast].wordSet.add(w);
  }

  const podcasts = Object.values(podcastMap).map(p => ({
    name: p.name,
    wordCount: p.wordSet.size,
    episodeCount: p.episodes.length,
    episodes: p.episodes.sort((a, b) => b.latestTimestamp.localeCompare(a.latestTimestamp)),
  })).sort((a, b) => b.wordCount - a.wordCount);

  const stats = { wordCount: allWords.length, podcastCount: podcasts.length, earliest, latest };

  return { words: allWords, tags, podcasts, stats };
}

// ─────────────────────────────────────────────
// Kana index
// ─────────────────────────────────────────────

function toHira(ch) {
  const code = ch.charCodeAt(0);
  return (code >= 0x30A1 && code <= 0x30F6) ? String.fromCharCode(code - 0x60) : ch;
}

function firstKanaChar(reading) {
  return reading ? toHira(reading[0]) : '';
}

// jdictDb is the better-sqlite3 handle for data/jdict.db, passed in by the caller.
function getKanaIndex(jdictDb) {
  const db = getWikiDb();

  const wordCounts = {};
  const wordRows = db.prepare('SELECT seq FROM wiki_words WHERE seq IS NOT NULL').all();
  if (wordRows.length > 0) {
    const seqs = wordRows.map(r => r.seq);
    const placeholders = seqs.map(() => '?').join(',');
    for (const e of jdictDb.prepare(`SELECT kana_json FROM entries WHERE seq IN (${placeholders})`).all(...seqs)) {
      const kana = JSON.parse(e.kana_json);
      const ch = firstKanaChar(kana[0]?.reb || '');
      if (ch) wordCounts[ch] = (wordCounts[ch] || 0) + 1;
    }
  }

  const cardCounts = {};
  for (const row of db.prepare('SELECT reading FROM wiki_cards').all()) {
    const ch = firstKanaChar(row.reading || '');
    if (ch) cardCounts[ch] = (cardCounts[ch] || 0) + 1;
  }

  return { words: wordCounts, cards: cardCounts };
}

function getKanaWords(jdictDb, char) {
  const db = getWikiDb();
  const hira = toHira(char);

  const words = [];
  const wordRows = db.prepare('SELECT slug, seq FROM wiki_words WHERE seq IS NOT NULL').all();
  if (wordRows.length > 0) {
    const seqs = wordRows.map(r => r.seq);
    const placeholders = seqs.map(() => '?').join(',');
    const entryMap = {};
    for (const e of jdictDb.prepare(`SELECT seq, kana_json FROM entries WHERE seq IN (${placeholders})`).all(...seqs)) {
      entryMap[e.seq] = e.kana_json;
    }
    for (const row of wordRows) {
      const kanaJson = entryMap[row.seq];
      if (!kanaJson) continue;
      const kana = JSON.parse(kanaJson);
      const reading = kana[0]?.reb || '';
      if (firstKanaChar(reading) === hira) words.push({ slug: row.slug, reading });
    }
  }
  words.sort((a, b) => a.reading.localeCompare(b.reading, 'ja'));

  const cards = [];
  for (const row of db.prepare('SELECT slug, reading, english, japanese FROM wiki_cards').all()) {
    if (firstKanaChar(row.reading || '') === hira) {
      cards.push({ slug: row.slug, reading: row.reading, english: row.english, japanese: row.japanese });
    }
  }
  cards.sort((a, b) => a.reading.localeCompare(b.reading, 'ja'));

  return { char: hira, words, cards };
}

module.exports = {
  slugify,
  getWordPage,
  wordExists,
  saveWordPage,
  getAllTags,
  getWikiIndexData,
  getWikiBrowseData,
  getTagPage,
  getWordsForTag,
  saveTagPage,
  getCardPage,
  getKanaIndex,
  getKanaWords,
};
