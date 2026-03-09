"""
db.py -- Database access layer for jdict-service.
"""

import json
import sqlite3
from pathlib import Path
from typing import Optional

DB_PATH = Path("data/jdict.db")

_conn: Optional[sqlite3.Connection] = None


def conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
    return _conn


def db_exists() -> bool:
    return DB_PATH.exists()


def _row_to_entry(row) -> dict:
    return {
        "seq":    row["seq"],
        "kanji":  json.loads(row["kanji_json"]  or "[]"),
        "kana":   json.loads(row["kana_json"]   or "[]"),
        "senses": json.loads(row["senses_json"] or "[]"),
        "jlpt":   row["jlpt"],
    }


def _is_japanese(q: str) -> bool:
    """True if the string contains any CJK / kana codepoints."""
    for ch in q:
        cp = ord(ch)
        if (0x3040 <= cp <= 0x30ff    # Hiragana + Katakana
                or 0x4e00 <= cp <= 0x9fff   # CJK Unified (common)
                or 0x3400 <= cp <= 0x4dbf   # CJK Extension A
                or 0xf900 <= cp <= 0xfaff   # CJK Compatibility
                or 0xff65 <= cp <= 0xff9f): # Halfwidth Katakana
            return True
    return False


def search(q: str, lang: str = "eng", limit: int = 20, offset: int = 0) -> list[dict]:
    """Search by kanji, kana, or English gloss."""
    q = q.strip()
    if not q:
        return []

    c = conn()

    if _is_japanese(q):
        # Substring match on the plain-text entries_text table, then fetch JSON
        rows = c.execute("""
            SELECT e.seq, e.kanji_json, e.kana_json, e.senses_json, e.jlpt
            FROM entries e
            JOIN entries_text t ON t.seq = e.seq
            WHERE t.kanji LIKE ? OR t.kana LIKE ?
            LIMIT ? OFFSET ?
        """, (f"%{q}%", f"%{q}%", limit, offset)).fetchall()
    else:
        # FTS5 full-text search on English glosses
        # FTS rowids = seq values (we inserted with explicit rowid=seq)
        fts_query = " ".join(
            '"' + word.replace('"', '') + '"*'
            for word in q.split() if word
        )
        try:
            fts_rows = c.execute(
                "SELECT rowid FROM entries_fts WHERE entries_fts MATCH ? ORDER BY rank LIMIT ? OFFSET ?",
                (fts_query, limit, offset)
            ).fetchall()
            seqs = [r[0] for r in fts_rows]
            if not seqs:
                return []
            placeholders = ",".join("?" * len(seqs))
            rows = c.execute(
                f"SELECT seq, kanji_json, kana_json, senses_json, jlpt FROM entries WHERE seq IN ({placeholders})",
                seqs
            ).fetchall()
        except sqlite3.OperationalError:
            # Fallback: LIKE on the gloss text column
            rows = c.execute("""
                SELECT e.seq, e.kanji_json, e.kana_json, e.senses_json, e.jlpt
                FROM entries e
                JOIN entries_text t ON t.seq = e.seq
                WHERE t.glosses LIKE ?
                LIMIT ? OFFSET ?
            """, (f"%{q}%", limit, offset)).fetchall()

    return [_row_to_entry(r) for r in rows]


def get_entry(seq: int) -> Optional[dict]:
    row = conn().execute(
        "SELECT seq, kanji_json, kana_json, senses_json, jlpt FROM entries WHERE seq=?", (seq,)
    ).fetchone()
    return _row_to_entry(row) if row else None


def get_by_jlpt(level: str, limit: int = 50, offset: int = 0) -> list[dict]:
    rows = conn().execute(
        "SELECT seq, kanji_json, kana_json, senses_json, jlpt FROM entries WHERE jlpt=? LIMIT ? OFFSET ?",
        (level.upper(), limit, offset)
    ).fetchall()
    return [_row_to_entry(r) for r in rows]


def random_entries(n: int = 5) -> list[dict]:
    rows = conn().execute(
        "SELECT seq, kanji_json, kana_json, senses_json, jlpt FROM entries ORDER BY RANDOM() LIMIT ?", (n,)
    ).fetchall()
    return [_row_to_entry(r) for r in rows]


def entry_count() -> int:
    row = conn().execute("SELECT COUNT(*) as c FROM entries").fetchone()
    return row["c"] if row else 0
