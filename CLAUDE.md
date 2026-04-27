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
node importer.js --xml sources/JMDict --db data/jdict.db

# Import KANJIDIC2 + KRADFILE into jdict.db (one-time setup)
node kanjiimporter.js

# Import Koohi/Heisig kanji stories into jdict.db (one-time setup, run after kanjiimporter)
node storiesImporter.js

# Import Tatoeba example sentences into data/tatoeba.db (one-time setup)
# Also reads sources/tatoeba/jpn_transcriptions.tsv for furigana readings
node tatoebaImporter.js

# Add/refresh readings on an existing tatoeba.db (if imported before readings were available)
node tatoebaAddReadings.js

# Import an Anki .apkg deck into the wiki (one-time or repeated)
node ankiimport.js file.apkg
node ankiimport.js file.apkg --limit 50   # test with a small batch first

# Re-download all source data and rebuild jdict.db from scratch
make rebuild   # see Makefile for download URLs
```

`data/` contains `jdict.db`, `wiki.db`, and `tatoeba.db` — all gitignored. `sources/` contains downloaded source files — also gitignored. `jdict.db` is fully reproducible via `make rebuild`. `tatoeba.db` is reproducible via `node tatoebaImporter.js`. `wiki.db` and `wiki/images/` are irreplaceable personal data — back them up separately (`make backup DEST=/path/to/backup`).

There are no automated tests (`npm test` exits with an error).

The server port defaults to 8000 but can be overridden with `PORT` env var. Ports are also stored in `config.json`.

## Docker

```bash
make build   # build the image
make up      # start the container
make down    # stop the container
make logs    # tail logs
```

The port is read from `config.json` via `jq` in the `Makefile` — it is the single source of truth. Do not hardcode ports in `Dockerfile` or `docker-compose.yml`.

`data/`, `sources/`, and `wiki/` are mounted from the host (paths defined in `docker-compose.yml`) and never baked into the image.

## Architecture

This is a Node.js/Express app (migrated from a Python/FastAPI origin — the `attic/` folder contains the old Python code). The stack is:

- **`index.js`** — Express server, all route definitions. Serves the frontend SPA and the REST API under `/api/`.
- **`db.js`** — SQLite access layer using `better-sqlite3`. Synchronous reads; the DB is opened lazily on first access. Contains search logic (Japanese kana/kanji LIKE queries, FTS5 for English glosses).
- **`wiki.js`** — SQLite-backed wiki system (`data/wiki.db`). Word pages, card pages, tags, and contexts are all stored in the database. Images remain on disk under `wiki/images/` and are served statically.
- **`tatoeba.js`** — Access layer for `data/tatoeba.db`. `search(word, page, limit)` does a `LIKE %word%` scan and groups multiple English translations per Japanese sentence. Returns `{ total, results }` where each result has `{ jp_id, japanese, reading, translations }`.
- **`importer.js`** — One-time JMdict XML → SQLite converter using `fast-xml-parser`. Creates the `entries`, `entries_text`, and `entries_fts` (FTS5) tables.
- **`tatoebaImporter.js`** — One-time Tatoeba TSV → SQLite importer. Reads `sources/tatoeba/sentences*.tsv` and `sources/tatoeba/jpn_transcriptions.tsv` (furigana). Creates `data/tatoeba.db` with a `sentences` table.
- **`tatoebaAddReadings.js`** — Patches an existing `tatoeba.db` to add the `reading` column from `jpn_transcriptions.tsv`. Use if the DB was imported before readings were available.
- **`ankiimport.js`** — One-time Anki `.apkg` → wiki importer. Handles the modern Anki format (zstd-compressed `collection.anki21b` and `media` file with protobuf map). For each note: if the Japanese field matches a JMdict entry, creates/updates a wiki word page (adds `anki` tag, image, story under `# Example`); otherwise writes a card page. Run with `node ankiimport.js file.apkg [--limit N]`.
- **`static/index.html`** — The entire frontend as a single self-contained HTML file (no build step). Implements client-side routing via `history.pushState`.
- **`config.json`** — Server constants: `port` (default 8000) and `podcastPort` (8014). Read by `index.js` at startup; exposed to the frontend via `GET /api/config`.

### Database schema

Three tables in `data/jdict.db`:
- `entries(seq, kanji_json, kana_json, senses_json, jlpt)` — main store; JSON blobs for kanji/kana/senses.
- `entries_text(seq, kanji, kana, glosses)` — denormalised text for search.
- `entries_fts` — FTS5 virtual table over `entries_text.glosses` for English full-text search.

One table in `data/tatoeba.db`:
- `sentences(jp_id, japanese, en_id, english, reading)` — one row per Japanese/English pair. `reading` contains Tatoeba furigana markup (`[漢字|か|な]`). Indexed on `japanese` and `jp_id`.

### Wiki format

Wiki data lives in `data/wiki.db`. The `wiki_words` table stores word pages: `slug`, `seq` (JMdict sequence number), `tags` (JSON array), `image` (filename), `contexts` (JSON array of lookup records), and `notes` (markdown body). Tag pages are auto-created when a word page references a new tag.

Card pages are stored in the `wiki_cards` table and created by `ankiimport.js` for Anki notes whose Japanese field does not match any JMdict entry. Fields: `slug`, `english`, `japanese`, `reading`, `image`, `notes`. Card pages are read-only (no edit UI); served at `/wiki/card/:slug` via `GET /api/wiki/card/:slug`.

Each entry in `contexts` has:
- `source` — a URL or `entry:{seq}` string
- `timestamp` — ISO date of the lookup
- `podcast`, `episode`, `podcastTimestamp` — optional; present when the lookup came from a podcast player

Context records are only added when a lookup originates from the podcast player (`podcastName` is set). Direct dictionary lookups never write context records. New wiki pages are created with empty notes and an empty contexts array.

### Search results — wiki badge

After rendering search results, the frontend fires a single `POST /api/wiki/exists` request with all result slugs. Entries that already have a wiki page get a small `wiki` badge (a direct link to the word page) next to the kanji. The badge insertion is guarded by a `searchEpoch` counter so stale responses from superseded searches are ignored.

### Dict / Wiki search toggle

A **Dict / Wiki** toggle button in the header switches between dictionary search and wiki search. In wiki mode:
- The URL updates to `/wiki/search/:word`
- `GET /api/wiki/search?q=` is called, implemented in `wiki.searchWiki(q, jdictDb)`
- Results match on slug directly, and also on kana/kanji reading via a join with `jdict.db`
- Results show slug + reading + first English gloss, linking directly to the wiki word page

### Podcast player integration

A podcast app calls `/search/{word}?podcast={name}&episode={path}&timestamp={seconds}` to look up a word while listening. The frontend:

1. Captures `podcast`, `episode`, `timestamp` from the query string at page load (with an extra `decodeURIComponent` pass to handle percent-encoded episode names).
2. Threads those params through entry links so they survive SPA navigation.
3. On the entry detail page, if the word already has a wiki page, **silently appends a new context record** to its lookup history (fire-and-forget fetch).
4. On the wiki word page, renders each podcast context as a clickable link back to the podcast player: `http://{hostname}:{podcastPort}/play/{episode}?t={seconds}&from=wiki`. The episode path is encoded with ASCII specials percent-encoded but Unicode left readable. The `podcastPort` comes from `/api/config`.

### Wiki word page — view and edit mode

The word page starts in **view mode**: notes are rendered as HTML, the textarea is hidden, tag × buttons and input are hidden, the image drop zone is non-interactive, and the empty drop zone is hidden entirely.

A **🖊️ quill icon** in the "Notes & Tags" section header toggles edit mode. In edit mode all fields become interactive.

- **Notes / image changes** mark the page dirty: a red **Save** button appears. It is hidden again after a successful save. After saving, `#wiki-notes-rendered` is refreshed from the server so view mode immediately shows the updated content.
- **Tag additions/removals** save immediately (no dirty state needed).
- **Tag lozenges** are links to `/wiki/tag/{name}` in view mode; in edit mode clicking a tag suppresses navigation and focuses the tag input instead.

### Tatoeba example sentences

On each wiki word page, a background fetch hits `GET /api/tatoeba/search?q=WORD&page=1&limit=1`. If any sentences exist, a small red-outlined **Tatoeba N sentences** button appears below the wiki form.

Clicking the button opens a paginated panel (20 per page). Each sentence shows the Japanese with furigana (rendered from Tatoeba's `[漢字|か|な]` markup as HTML `<ruby>` tags) and the English translation(s). A **Use** button appends the sentence to the notes under a `# Tatoeba` heading (subsequent sentences are appended without repeating the heading) and auto-saves immediately.

The furigana markup converter (`tatoebaToRuby`) produces `<ruby>` HTML that `marked` passes through unchanged, so furigana are visible in rendered notes view.

### Wiki index — tab navigation

The wiki index (`/wiki`) uses a four-tab layout:
- **Index** — gojuuon kana grid linking to `/wiki/kana/:char`
- **Recent** — words sorted by `updated_at` and `created_at` (top 50 each)
- **Tags** — tag cloud sized by word count
- **Podcasts** — words grouped by podcast and episode, with a filter input

Active tab is stored in `location.hash` (`/wiki#recent` etc.) so the back button and page refresh land on the right tab.

### Image import

Three methods are available on the wiki word page (edit mode):

1. **Drop zone** — drag an image file onto the zone, or click to file-pick. Works on all platforms.
2. **Find on Google Images** — opens `google.com/search?q=WORD&tbm=isch` in a new tab and stores the current slug in `sessionStorage('sharedImageTarget')` for the share target flow below.
3. **Paste from clipboard** — reads an image from the system clipboard via `navigator.clipboard.read()`. Only shown when the API is available (requires HTTPS or localhost). On macOS: copy image in any browser → Paste from clipboard. On iOS 16+: copy image → Paste from clipboard.
4. **Web Share Target** (iOS 16.4+ only, PWA must be installed to home screen) — jdict registers as a share target in `manifest.json`. Flow: find image in Safari → Share → jdict → server saves image to `wiki/images/` → redirects to `/?sharedImage=FILENAME` → client reads `sessionStorage('sharedImageTarget')` → navigates to the word page → image auto-saved. On macOS, Web Share Target for files is not yet supported by Safari PWAs; use drag-and-drop or clipboard instead.

The share target POST endpoint is `POST /share`, handled by the existing multer middleware. It redirects to `/?sharedImage=FILENAME` on success.

### Client-side routing

The server sends `static/index.html` for all frontend routes. Current routes:

| Path | View |
|------|------|
| `/` | Search (dictionary mode) |
| `/search/:word` | Dictionary search results |
| `/wiki/search/:word` | Wiki search results |
| `/entry/:seq` | Dictionary entry detail |
| `/wiki` | Wiki index (tabbed: Index, Recent, Tags, Podcasts) |
| `/wiki/word/:slug` | Wiki word page (view/edit) |
| `/wiki/tag/:name` | Tag page |
| `/wiki/card/:slug` | Card page (read-only, from Anki import) |
| `/wiki/kana/:char` | Kana index page — all words/cards starting with that character |
| `/share` | Web Share Target landing (GET serves SPA; POST receives shared image) |

### Kana index

The wiki index page shows a gojuuon grid (あいうえお…わをん). Each active cell links to `/wiki/kana/:char`. The kana index page lists:
- **Words** — wiki word pages, sorted by primary JMdict reading (`kana_json[0].reb`)
- **Cards** — card pages, sorted by their `reading` field

API: `GET /api/wiki/kana-index` (counts per character), `GET /api/wiki/kana/:char` (full word/card lists). Katakana readings are normalised to hiragana for grouping.

## Conventions and decisions

### Wiki notes
- Never pre-fill the notes field with English glosses when creating a new wiki page. The glosses already appear at the top of the entry — putting them in notes too is redundant.
- Notes are for the user's own observations, not auto-generated content.
- Notes are stored as markdown and rendered with `marked`. Inline HTML (e.g. `<ruby>` tags from Tatoeba) is passed through unchanged.

### Wiki contexts
- Context records are only written when a lookup comes from the podcast player (`podcastName` is set in the query string).
- Direct dictionary lookups never write context records — not on new page creation, not on existing page load.

### Entry detail page flow
- If the word already has a wiki page, the button reads **View in Wiki** and navigates directly to the word page.
- If not, the button reads **+ Add to Wiki**, creates the page, and navigates to it.
- The `wiki` badge in search results is a direct link to the wiki word page.

### Ports / config
- `config.json` is the single source of truth for port numbers. Do not hardcode ports anywhere else (Dockerfile, docker-compose.yml, env vars). The Makefile reads the port from `config.json` via `jq`.

### Pending work
- Wiki image uploads currently preserve the original format (JPEG, PNG, GIF, WebP mixed). There is an open intention to standardise on a single format (JPEG or WebP) using `sharp` for server-side conversion, and potentially backfill existing images. Target format not yet decided.
