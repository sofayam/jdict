/**
 * index.js — jdict-service Express application.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const database = require('./db');

const app = express();
const PORT = process.env.PORT || 8000;

// Middleware to ensure UTF-8 for JSON responses (API only)
app.use('/api', (req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

// Serve static files (the frontend)
app.use('/static', express.static(path.join(__dirname, 'static')));

// ─────────────────────────────────────────────
// Frontend
// ─────────────────────────────────────────────

app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'static', 'index.html');
  if (!fs.existsSync(indexPath)) {
    return res.status(500).send('<h1>Frontend not found</h1><p>static/index.html is missing.</p>');
  }
  res.sendFile(indexPath);
});

// ─────────────────────────────────────────────
// Health / status
// ─────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  /** Returns service health and database stats. */
  const ready = database.dbExists();
  const count = ready ? database.entryCount() : 0;
  res.json({
    status: ready ? 'ok' : 'no_database',
    database: database.DB_PATH,
    entry_count: count,
    ready: ready,
  });
});

// ─────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────

app.get('/api/search', (req, res) => {
  /**
   * Search the dictionary by kanji, kana, or English meaning.
   */
  const { q, limit = 20, offset = 0 } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Query parameter "q" is required' });
  }

  if (!database.dbExists()) {
    return res.status(503).json({ error: 'Database not initialised. Run: node importer.js' });
  }

  const limitInt = parseInt(limit, 10);
  const offsetInt = parseInt(offset, 10);

  const results = database.search(q, 'eng', limitInt, offsetInt);
  res.json({
    query: q,
    count: results.length,
    offset: offsetInt,
    results: results,
  });
});

// ─────────────────────────────────────────────
// Single entry lookup
// ─────────────────────────────────────────────

app.get('/api/entry/:seq', (req, res) => {
  /**
   * Look up a single dictionary entry by its JMdict sequence number.
   */
  if (!database.dbExists()) {
    return res.status(503).json({ error: 'Database not initialised. Run: node importer.js' });
  }

  const seq = parseInt(req.params.seq, 10);
  const entry = database.getEntry(seq);
  if (!entry) {
    return res.status(404).json({ error: `Entry ${seq} not found` });
  }
  res.json(entry);
});

// ─────────────────────────────────────────────
// JLPT filter
// ─────────────────────────────────────────────

app.get('/api/jlpt/:level', (req, res) => {
  /**
   * Return entries tagged with a JLPT level (N1–N5).
   */
  if (!database.dbExists()) {
    return res.status(503).json({ error: 'Database not initialised.' });
  }

  const level = req.params.level.toUpperCase();
  if (!['N1', 'N2', 'N3', 'N4', 'N5'].includes(level)) {
    return res.status(400).json({ error: 'Level must be N1, N2, N3, N4, or N5' });
  }

  const { limit = 50, offset = 0 } = req.query;
  const limitInt = parseInt(limit, 10);
  const offsetInt = parseInt(offset, 10);

  const results = database.getByJlpt(level, limitInt, offsetInt);
  res.json({
    jlpt: level,
    count: results.length,
    offset: offsetInt,
    results: results,
  });
});

// ─────────────────────────────────────────────
// Random entries
// ─────────────────────────────────────────────

app.get('/api/random', (req, res) => {
  /** Return n random dictionary entries. */
  if (!database.dbExists()) {
    return res.status(503).json({ error: 'Database not initialised.' });
  }

  const n = parseInt(req.query.n || 5, 10);
  res.json({ results: database.randomEntries(n) });
});

app.listen(PORT, () => {
  console.log(`jdict-service running at http://localhost:${PORT}`);
});
