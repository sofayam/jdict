"""
main.py — jdict-service FastAPI application.

Run with:
    uvicorn main:app --host 0.0.0.0 --port 8000 --reload

API docs auto-available at http://localhost:8000/docs
"""

import json
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

import db as database


class UTF8JSONResponse(JSONResponse):
    """JSONResponse that explicitly sets charset=utf-8 and uses ensure_ascii=False.

    FastAPI's default JSONResponse omits the charset parameter, which causes some
    HTTP clients to fall back to Latin-1 and display Japanese text as garbage.
    """
    media_type = "application/json; charset=utf-8"

    def render(self, content: Any) -> bytes:
        return json.dumps(
            content,
            ensure_ascii=False,
            allow_nan=False,
            indent=None,
            separators=(",", ":"),
        ).encode("utf-8")

# ─────────────────────────────────────────────
# App setup
# ─────────────────────────────────────────────

app = FastAPI(
    title="jdict-service",
    description="Local Japanese dictionary API backed by JMdict",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
    default_response_class=UTF8JSONResponse,
)

# Serve static files (the frontend)
static_path = Path("static")
static_path.mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")


# ─────────────────────────────────────────────
# Frontend
# ─────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse, include_in_schema=False)
def frontend():
    index = Path("static/index.html")
    if not index.exists():
        return HTMLResponse("<h1>Frontend not found</h1><p>static/index.html is missing.</p>", status_code=500)
    return HTMLResponse(index.read_text(encoding="utf-8"))


# ─────────────────────────────────────────────
# Health / status
# ─────────────────────────────────────────────

@app.get("/api/status", tags=["meta"])
def status():
    """Returns service health and database stats."""
    ready = database.db_exists()
    count = database.entry_count() if ready else 0
    return {
        "status": "ok" if ready else "no_database",
        "database": str(database.DB_PATH),
        "entry_count": count,
        "ready": ready,
    }


# ─────────────────────────────────────────────
# Search
# ─────────────────────────────────────────────

@app.get("/api/search", tags=["dictionary"])
def search(
    q: str = Query(..., description="Search term: kanji, kana, or English gloss"),
    limit: int = Query(20, ge=1, le=100, description="Max results to return"),
    offset: int = Query(0, ge=0, description="Pagination offset"),
):
    """
    Search the dictionary by kanji, kana, or English meaning.

    - Japanese input (kanji/kana) uses substring matching.
    - Romaji/English input uses full-text search with prefix matching.

    Returns a list of matching entries.
    """
    if not database.db_exists():
        raise HTTPException(503, "Database not initialised. Run: python importer.py")

    results = database.search(q, limit=limit, offset=offset)
    return {
        "query": q,
        "count": len(results),
        "offset": offset,
        "results": results,
    }


# ─────────────────────────────────────────────
# Single entry lookup
# ─────────────────────────────────────────────

@app.get("/api/entry/{seq}", tags=["dictionary"])
def get_entry(seq: int):
    """
    Look up a single dictionary entry by its JMdict sequence number.
    """
    if not database.db_exists():
        raise HTTPException(503, "Database not initialised. Run: python importer.py")

    entry = database.get_entry(seq)
    if not entry:
        raise HTTPException(404, f"Entry {seq} not found")
    return entry


# ─────────────────────────────────────────────
# JLPT filter
# ─────────────────────────────────────────────

@app.get("/api/jlpt/{level}", tags=["dictionary"])
def jlpt(
    level: str,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """
    Return entries tagged with a JLPT level (N1–N5).

    Note: JLPT data is not included in JMdict itself. Populate the `jlpt`
    column in the entries table using a separate JLPT word list
    (e.g. jlpt-vocab-lists from jonbrine/jlpt-vocab on GitHub).
    """
    if not database.db_exists():
        raise HTTPException(503, "Database not initialised.")
    level = level.upper()
    if level not in ("N1", "N2", "N3", "N4", "N5"):
        raise HTTPException(400, "Level must be N1, N2, N3, N4, or N5")
    results = database.get_by_jlpt(level, limit=limit, offset=offset)
    return {
        "jlpt": level,
        "count": len(results),
        "offset": offset,
        "results": results,
    }


# ─────────────────────────────────────────────
# Random entries
# ─────────────────────────────────────────────

@app.get("/api/random", tags=["dictionary"])
def random_entries(n: int = Query(5, ge=1, le=20)):
    """Return n random dictionary entries. Useful for word-of-the-day features."""
    if not database.db_exists():
        raise HTTPException(503, "Database not initialised.")
    return {"results": database.random_entries(n)}
