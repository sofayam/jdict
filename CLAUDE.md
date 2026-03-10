# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install

# Run the server (production)
npm start          # node index.js, serves on port 8000

# Run the server (development, with auto-reload)
npm run dev        # nodemon index.js

# Import JMdict XML into the SQLite database (one-time setup)
node importer.js --xml data/JMdict --db data/jdict.db
```

There are no automated tests (`npm test` exits with an error).

The server port defaults to 8000 but can be overridden with `PORT` env var.

## Architecture

This is a Node.js/Express app (migrated from a Python/FastAPI origin — the `attic/` folder contains the old Python code). The stack is:

- **`index.js`** — Express server, all route definitions. Serves the frontend SPA and the REST API under `/api/`.
- **`db.js`** — SQLite access layer using `better-sqlite3`. Synchronous reads; the DB is opened lazily on first access. Contains search logic (Japanese kana/kanji LIKE queries, FTS5 for English glosses).
- **`wiki.js`** — File-based wiki system using `gray-matter` for markdown+frontmatter. Word and tag pages are stored as `.md` files under `wiki/words/` and `wiki/tags/`. Images are stored in `wiki/images/` and served statically.
- **`importer.js`** — One-time JMdict XML → SQLite converter using `fast-xml-parser`. Creates the `entries`, `entries_text`, and `entries_fts` (FTS5) tables.
- **`static/index.html`** — The entire frontend as a single self-contained HTML file (no build step). Implements client-side routing via `history.pushState`. Views: search, entry detail, wiki index, word page, tag page.

### Database schema

Three tables in `data/jdict.db`:
- `entries(seq, kanji_json, kana_json, senses_json, jlpt)` — main store; JSON blobs for kanji/kana/senses.
- `entries_text(seq, kanji, kana, glosses)` — denormalised text for search.
- `entries_fts` — FTS5 virtual table over `entries_text.glosses` for English full-text search.

### Wiki format

Word and tag pages are markdown files with YAML frontmatter (via `gray-matter`). Frontmatter fields on word pages include `tags` (array), `seq` (JMdict sequence number), `image` (filename), and lookup context. The `notes` field maps to the markdown body. Tag pages are auto-created when a word page references a new tag.

### Client-side routing

The server sends `static/index.html` for all frontend routes (`/`, `/entry/:seq`, `/wiki`, `/wiki/word/:word`, `/wiki/tag/:name`, `/search/:word`). The frontend JS reads `window.location.pathname` to determine which view to render, using `history.pushState` for navigation.
