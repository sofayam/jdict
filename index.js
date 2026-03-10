/**
 * index.js — jdict-service Express application.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const database = require('./db');
const wiki = require('./wiki');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 8000;

// Multer configuration for image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'wiki', 'images'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = uuidv4();
    const fileExtension = path.extname(file.originalname);
    cb(null, `${uniqueSuffix}${fileExtension}`);
  }
});
const upload = multer({
  storage: storage,
  limits: { fileSize: 1 * 1024 * 1024 }, // 1MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const mimetype = allowedTypes.test(file.mimetype);
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());

    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Only images (jpeg, jpg, png, gif) are allowed'));
  }
});

app.use(express.json());

// Middleware to ensure UTF-8 for JSON responses (API only)
app.use('/api', (req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

// Serve static files (the frontend)
app.use('/static', express.static(path.join(__dirname, 'static')));
// Serve wiki images
app.use('/wiki/images', express.static(path.join(__dirname, 'wiki', 'images')));

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

// ─────────────────────────────────────────────
// Wiki
// ─────────────────────────────────────────────

app.get('/api/wiki/index', async (req, res) => {
  try {
    const indexData = await wiki.getWikiIndexData();
    res.json(indexData);
  } catch (error) {
    console.error('Failed to get wiki index:', error);
    res.status(500).json({ error: 'Failed to get wiki index' });
  }
});

app.get('/api/wiki/tags', async (req, res) => {
  try {
    const tags = await wiki.getAllTags();
    res.json(tags);
  } catch (error) {
    console.error('Failed to get wiki tags:', error);
    res.status(500).json({ error: 'Failed to get wiki tags' });
  }
});

app.get('/api/wiki/word/:word', async (req, res) => {
  try {
    const page = await wiki.getWordPage(req.params.word);
    if (page) {
      res.json(page);
    } else {
      // This is not an error, it just means no page has been created yet.
      res.status(404).json({ error: 'Wiki page not found' });
    }
  } catch (error)
 {
    console.error(`Failed to get wiki page for word ${req.params.word}:`, error);
    res.status(500).json({ error: 'Failed to get wiki page' });
  }
});

app.post('/api/wiki/word/:word', async (req, res) => {
  try {
    await wiki.saveWordPage(req.params.word, req.body);
    res.status(201).json({ status: 'ok' });
  } catch (error) {
    console.error(`Failed to save wiki page for word ${req.params.word}:`, error);
    res.status(500).json({ error: 'Failed to save wiki page' });
  }
});

app.get('/api/wiki/tag/:name', async (req, res) => {
  try {
    const tagName = req.params.name;
    const [tagPage, words] = await Promise.all([
      wiki.getTagPage(tagName),
      wiki.getWordsForTag(tagName)
    ]);

    if (!tagPage) {
      return res.status(404).json({ error: 'Tag page not found' });
    }

    res.json({ ...tagPage, words });
  } catch (error) {
    console.error(`Failed to get tag page for tag ${req.params.name}:`, error);
    res.status(500).json({ error: 'Failed to get tag page' });
  }
});

app.post('/api/wiki/tag/:name', async (req, res) => {
  try {
    await wiki.saveTagPage(req.params.name, req.body);
    res.status(201).json({ status: 'ok' });
  } catch (error) {
    console.error(`Failed to save tag page for tag ${req.params.name}:`, error);
    res.status(500).json({ error: 'Failed to save tag page' });
  }
});

app.post('/api/wiki/image-upload', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  res.json({ filename: req.file.filename });
});

app.get('/entry/:seq', (req, res) => {
  // Client-side router will handle rendering the entry.
  res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

app.get('/wiki/word/:word', (req, res) => {
  // Client-side router will handle rendering the wiki page.
  res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

app.get('/wiki', (req, res) => {
  // Client-side router will handle rendering the wiki index.
  res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

app.get('/wiki/tag/:name', (req, res) => {
  // Client-side router will handle rendering the tag page.
  res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

app.get('/search/:word', (req, res, next) => {
  const { word } = req.params;
  // Avoid treating file requests (like favicon.ico) as search terms.
  if (word.includes('.')) {
    return next();
  }
  // Client-side router will handle the search.
  res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`jdict-service running at http://localhost:${PORT}`);
});
