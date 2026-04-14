PORT := $(shell jq .port config.json)
export PORT

up:
	docker compose up -d

down:
	docker compose down

build:
	docker compose build

logs:
	docker compose logs -f

# ── Data setup ────────────────────────────────────────────────────────────────
# Run this once (or again) to download source files and rebuild jdict.db.
# wiki.db is NOT touched — it holds your personal notes and must be backed up separately.

download:
	mkdir -p sources data
	# JMdict — Japanese-English dictionary (EDRDG, CC BY-SA 4.0)
	curl -fL http://ftp.edrdg.org/pub/Nihongo/JMdict.gz | gunzip > sources/JMDict
	# KANJIDIC2 — kanji readings, meanings, stroke/grade/JLPT (EDRDG, CC BY-SA 4.0)
	curl -fL http://ftp.edrdg.org/pub/Nihongo/kanjidic2.xml.gz | gunzip > sources/kanjidic2.xml
	# KRADFILE — kanji-to-radical decomposition (EDRDG)
	curl -fL http://ftp.edrdg.org/pub/Nihongo/kradzip.zip -o sources/kradzip.zip
	cd sources && unzip -o kradzip.zip
	# KanjiVG — stroke-order SVGs (CC BY-SA 3.0)
	# Check https://github.com/KanjiVG/kanjivg/releases for the latest filename.
	@echo "KanjiVG: download the latest kanjivg-YYYYMMDD-main.zip from"
	@echo "  https://github.com/KanjiVG/kanjivg/releases"
	@echo "and extract into sources/kanjivg/"

import:
	node importer.js --xml sources/JMDict --db data/jdict.db
	node kanjiimporter.js --db data/jdict.db --kanjidic sources/kanjidic2.xml --kradfile sources/kradfile

rebuild: download import
	@echo "jdict.db rebuilt."

backup:
	@echo "Backing up irreplaceable data..."
	@test -n "$(DEST)" || (echo "Usage: make backup DEST=/path/to/backup"; exit 1)
	rsync -av data/wiki.db wiki/images/ $(DEST)/
