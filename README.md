# 辞書 jdict-service

A locally-hosted Japanese dictionary web service backed by JMdict.
Provides a polished web frontend and a clean REST API for other apps.

---

## Quick Start

### 1. Install dependencies

```bash
pip install -r requirements.txt
```

### 2. Get JMdict

Download the JMdict file from the Electronic Dictionary Research and Development Group:

```bash
# Download and decompress
curl -O http://ftp.edrdg.org/pub/Nihongo/JMdict.gz
gunzip JMdict.gz
mv JMdict data/JMdict
```

Or visit https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project for more options.

### 3. Import the dictionary

```bash
python importer.py --xml data/JMdict --db data/jdict.db
```

This parses the JMdict XML (~210k entries) and writes an optimised SQLite
database with FTS5 full-text search. Takes about 30–60 seconds.

### 4. Start the service

```bash
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

- **Web frontend**: http://localhost:8000/
- **API docs (Swagger)**: http://localhost:8000/docs
- **API docs (ReDoc)**: http://localhost:8000/redoc

---

## API Reference

### `GET /api/status`
Returns service health and entry count.

```json
{ "status": "ok", "entry_count": 213575, "ready": true }
```

---

### `GET /api/search`
Search by kanji, kana, or English meaning.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `q`       | string | required | Search query |
| `limit`   | int | 20 | Max results (1–100) |
| `offset`  | int | 0 | Pagination offset |

**Examples:**
```
GET /api/search?q=食べる
GET /api/search?q=taberu
GET /api/search?q=to+eat
GET /api/search?q=beautiful&limit=50
```

**Response:**
```json
{
  "query": "食べる",
  "count": 1,
  "offset": 0,
  "results": [
    {
      "seq": 1358280,
      "kanji": [{ "keb": "食べる", "ke_inf": [], "ke_pri": ["ichi1"] }],
      "kana":  [{ "reb": "たべる", "re_nokanji": false, "re_inf": [], "re_pri": ["ichi1"], "re_restr": [] }],
      "senses": [
        {
          "pos": ["v1", "vt"],
          "glosses": [{ "lang": "eng", "text": "to eat", "g_type": "" }],
          "misc": [], "field": [], "xref": [], "ant": [], "s_inf": [], ...
        }
      ],
      "jlpt": null
    }
  ]
}
```

---

### `GET /api/entry/{seq}`
Fetch a single entry by its JMdict sequence number.

```
GET /api/entry/1358280
```

Returns the full entry object or 404 if not found.

---

### `GET /api/jlpt/{level}`
Return entries filtered by JLPT level (`N1`–`N5`).

> **Note**: JMdict itself does not include JLPT data. To use this endpoint,
> populate the `jlpt` column in the `entries` table using a JLPT word list.
> See the JLPT section below.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `level`   | path | required | N1, N2, N3, N4, or N5 |
| `limit`   | int | 50 | Max results (1–200) |
| `offset`  | int | 0 | Pagination offset |

```
GET /api/jlpt/N5?limit=20
```

---

### `GET /api/random`
Return random dictionary entries.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `n`       | int | 5 | Number of entries (1–20) |

```
GET /api/random?n=3
```

---

## Adding JLPT Data

JMdict doesn't include JLPT levels. To add them:

1. Get a JLPT vocabulary list (e.g. https://github.com/jbrownlee/jlpt-vocab)
2. For each vocabulary item, look up the JMdict sequence number and run:

```sql
UPDATE entries SET jlpt = 'N5' WHERE seq = 1358280;
```

Or write a small Python script to bulk-update using the search API to find
sequence numbers by kanji/kana.

---

## Running as a System Service (Linux)

Create `/etc/systemd/system/jdict.service`:

```ini
[Unit]
Description=jdict dictionary service
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/path/to/jdict-service
ExecStart=uvicorn main:app --host 127.0.0.1 --port 8000
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl enable jdict
sudo systemctl start jdict
```

---

## Project Structure

```
jdict-service/
├── main.py          # FastAPI app + all API routes
├── importer.py      # One-time JMdict XML → SQLite converter
├── db.py            # Database access layer
├── static/
│   └── index.html   # Web frontend (served at /)
├── data/
│   ├── JMdict       # JMdict XML (you provide)
│   └── jdict.db     # Generated SQLite DB (created by importer.py)
├── requirements.txt
└── README.md
```

---

## License

JMdict data is copyright of the Electronic Dictionary Research and Development Group.
See https://www.edrdg.org/edrdg/licence.html for the licence terms (Creative Commons Attribution-ShareAlike 4.0 International).

The service code in this project is MIT-licensed.
