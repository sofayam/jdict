"""
importer.py — Convert JMdict XML to a SQLite database.

Usage:
    python importer.py --xml data/JMdict --db data/jdict.db

The JMdict XML file can be downloaded from:
    https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project
    Direct: http://ftp.edrdg.org/pub/Nihongo/JMdict.gz  (then gunzip)
"""

import argparse
import sqlite3
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path


def strip_entity(text: str) -> str:
    """'&v1;' -> 'v1'"""
    if text and text.startswith("&") and text.endswith(";"):
        return text[1:-1]
    return text or ""


def create_schema(conn: sqlite3.Connection):
    conn.executescript("""
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;

        CREATE TABLE IF NOT EXISTS entries (
            seq         INTEGER PRIMARY KEY,
            kanji_json  TEXT,
            kana_json   TEXT,
            senses_json TEXT,
            jlpt        TEXT
        );

        -- Plain text table for search (kanji/kana LIKE + FTS glosses)
        CREATE TABLE IF NOT EXISTS entries_text (
            seq     INTEGER PRIMARY KEY,
            kanji   TEXT NOT NULL DEFAULT '',
            kana    TEXT NOT NULL DEFAULT '',
            glosses TEXT NOT NULL DEFAULT ''
        );

        -- FTS5 over entries_text for English gloss search
        CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
            glosses,
            content='entries_text',
            content_rowid='seq'
        );
    """)
    conn.commit()


def parse_entry(entry_el) -> dict:
    import json

    seq = int(entry_el.findtext("ent_seq", "0"))

    kanji_list = []
    for k_el in entry_el.findall("k_ele"):
        kanji_list.append({
            "keb":    k_el.findtext("keb", ""),
            "ke_inf": [strip_entity(e.text) for e in k_el.findall("ke_inf")],
            "ke_pri": [e.text for e in k_el.findall("ke_pri")],
        })

    kana_list = []
    for r_el in entry_el.findall("r_ele"):
        kana_list.append({
            "reb":        r_el.findtext("reb", ""),
            "re_nokanji": r_el.find("re_nokanji") is not None,
            "re_inf":     [strip_entity(e.text) for e in r_el.findall("re_inf")],
            "re_pri":     [e.text for e in r_el.findall("re_pri")],
            "re_restr":   [e.text for e in r_el.findall("re_restr")],
        })

    senses = []
    for s_el in entry_el.findall("sense"):
        pos   = [strip_entity(e.text) for e in s_el.findall("pos")]
        misc  = [strip_entity(e.text) for e in s_el.findall("misc")]
        field = [strip_entity(e.text) for e in s_el.findall("field")]
        dial  = [strip_entity(e.text) for e in s_el.findall("dial")]
        stagk = [e.text for e in s_el.findall("stagk")]
        stagr = [e.text for e in s_el.findall("stagr")]
        xref  = [e.text for e in s_el.findall("xref")]
        ant   = [e.text for e in s_el.findall("ant")]
        lsource = []
        for ls in s_el.findall("lsource"):
            lsource.append({
                "lang": ls.get("{http://www.w3.org/XML/1998/namespace}lang", "eng"),
                "text": ls.text or "",
                "ls_type": ls.get("ls_type", ""),
                "ls_wasei": ls.get("ls_wasei", ""),
            })
        glosses = []
        for g in s_el.findall("gloss"):
            lang = g.get("{http://www.w3.org/XML/1998/namespace}lang", "eng")
            glosses.append({"lang": lang, "text": g.text or "", "g_type": g.get("g_type", "")})
        s_inf = [e.text for e in s_el.findall("s_inf")]

        senses.append({
            "pos": pos, "misc": misc, "field": field, "dial": dial,
            "stagk": stagk, "stagr": stagr, "xref": xref, "ant": ant,
            "lsource": lsource, "glosses": glosses, "s_inf": s_inf,
        })

    return {
        "seq": seq,
        "kanji": kanji_list,
        "kana": kana_list,
        "senses": senses,
    }


def import_jmdict(xml_path: Path, db_path: Path):
    import json, re

    print(f"Opening {xml_path} ...")
    t0 = time.time()

    conn = sqlite3.connect(db_path)
    create_schema(conn)

    print("Reading XML (stripping DOCTYPE entities) ...")
    raw = xml_path.read_bytes()

    # Strip DOCTYPE block
    doctype_end = raw.find(b"]>")
    if doctype_end != -1:
        xml_decl_end = raw.find(b"?>")
        if xml_decl_end != -1:
            header = raw[:xml_decl_end + 2]
            body = raw[doctype_end + 2:]
            raw = header + body
        else:
            raw = raw[doctype_end + 2:]

    # Replace XML entity refs (&v1; etc.) with their names as plain text
    raw = re.sub(rb"&([A-Za-z0-9_-]+);", rb"\1", raw)

    print("Parsing XML ...")
    root = ET.fromstring(raw)

    entries      = []
    text_rows    = []
    fts_rows     = []
    batch_size   = 5000
    total        = 0

    for entry_el in root.iter("entry"):
        e = parse_entry(entry_el)

        kanji_text  = " ".join(k["keb"] for k in e["kanji"])
        kana_text   = " ".join(k["reb"] for k in e["kana"])
        gloss_text  = " ".join(
            g["text"] for s in e["senses"] for g in s["glosses"] if g["lang"] == "eng"
        )

        entries.append((
            e["seq"],
            json.dumps(e["kanji"],  ensure_ascii=False),
            json.dumps(e["kana"],   ensure_ascii=False),
            json.dumps(e["senses"], ensure_ascii=False),
            None,  # jlpt
        ))
        text_rows.append((e["seq"], kanji_text, kana_text, gloss_text))
        fts_rows.append((e["seq"], gloss_text))
        total += 1

        if len(entries) >= batch_size:
            conn.executemany("INSERT OR REPLACE INTO entries VALUES (?,?,?,?,?)", entries)
            conn.executemany("INSERT OR REPLACE INTO entries_text VALUES (?,?,?,?)", text_rows)
            conn.executemany("INSERT INTO entries_fts(rowid, glosses) VALUES (?,?)", fts_rows)
            conn.commit()
            entries.clear(); text_rows.clear(); fts_rows.clear()
            print(f"  ... {total:,} entries imported", end="\r")

    if entries:
        conn.executemany("INSERT OR REPLACE INTO entries VALUES (?,?,?,?,?)", entries)
        conn.executemany("INSERT OR REPLACE INTO entries_text VALUES (?,?,?,?)", text_rows)
        conn.executemany("INSERT INTO entries_fts(rowid, glosses) VALUES (?,?)", fts_rows)
        conn.commit()

    # Index entries_text for fast LIKE searches
    print("\nBuilding indexes ...")
    conn.executescript("""
        CREATE INDEX IF NOT EXISTS idx_text_kanji ON entries_text(kanji);
        CREATE INDEX IF NOT EXISTS idx_text_kana  ON entries_text(kana);
    """)
    conn.commit()

    print(f"Done. {total:,} entries imported in {time.time()-t0:.1f}s -> {db_path}")
    conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Import JMdict XML into SQLite")
    parser.add_argument("--xml", default="data/JMdict",   help="Path to JMdict XML file")
    parser.add_argument("--db",  default="data/jdict.db", help="Output SQLite path")
    args = parser.parse_args()

    xml_path = Path(args.xml)
    db_path  = Path(args.db)

    if not xml_path.exists():
        print(f"ERROR: XML file not found: {xml_path}", file=sys.stderr)
        print("Download JMdict from: http://ftp.edrdg.org/pub/Nihongo/JMdict.gz", file=sys.stderr)
        sys.exit(1)

    db_path.parent.mkdir(parents=True, exist_ok=True)
    import_jmdict(xml_path, db_path)
