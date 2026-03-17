#!/usr/bin/env node
/**
 * import-words.js — Import lookup history from WORDS.db into jdict wiki pages.
 *
 * For each Japanese word in WORDS.db:
 *   1. Find its JMdict seq by searching entries_text for a standalone token match
 *   2. Load existing wiki page (if any)
 *   3. Merge new contexts (dedup by timestamp)
 *   4. Save the page
 *
 * Usage:
 *   node import-words.js [--dry-run] [--limit=N]
 *   node import-words.js --words-db=<path> --jdict-db=<path> [--dry-run] [--limit=N]
 */

const path = require('path');
const Database = require('better-sqlite3');
const wiki = require('./wiki');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;
const wordsDbPath = args.find(a => a.startsWith('--words-db='))?.split('=')[1]
  ?? path.join(__dirname, 'WORDS.db');
const jdictDbPath = args.find(a => a.startsWith('--jdict-db='))?.split('=')[1]
  ?? path.join(__dirname, 'data', 'jdict.db');

const wordsDb = new Database(wordsDbPath, { readonly: true });
const jdictDb = new Database(jdictDbPath, { readonly: true });

// Match word as a standalone space-delimited token in the kanji/kana columns
const findSeq = jdictDb.prepare(`
  SELECT seq FROM entries_text
  WHERE (' ' || kanji || ' ') LIKE ('%' || ' ' || ? || ' ' || '%')
     OR (' ' || kana  || ' ') LIKE ('%' || ' ' || ? || ' ' || '%')
  LIMIT 1
`);

const getJapaneseWords = wordsDb.prepare(`
  SELECT
    w.id,
    w.word,
    w.url,
    json_group_array(json_object(
      'source',           w.url,
      'timestamp',        l.lookup_timestamp,
      'podcast',          l.podcast_name,
      'episode',          l.episode_name,
      'podcastTimestamp', l.episode_timestamp
    )) AS lookups_json
  FROM words w
  JOIN lookups l ON l.word_id = w.id
  WHERE w.language = 'ja'
  GROUP BY w.id
  ORDER BY w.word
`);

async function main() {
  const rows = getJapaneseWords.all();
  console.log(`Found ${rows.length} Japanese words with lookups`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  let created = 0, updated = 0, skipped = 0;

  for (const row of rows) {
    const word = row.word;
    const incomingContexts = JSON.parse(row.lookups_json);

    // Resolve JMdict seq
    const seqRow = findSeq.get(word, word);
    const resolvedSeq = seqRow?.seq ?? null;

    // Load existing wiki page
    const existing = await wiki.getWordPage(word);

    // Deduplicate against existing contexts by timestamp
    const existingTimestamps = new Set((existing?.contexts ?? []).map(c => c.timestamp));
    const newContexts = incomingContexts
      .filter(c => !existingTimestamps.has(c.timestamp))
      .map(c => ({ ...c, episode: `/${c.podcast}/${c.episode}.mp3` }));

    if (existing && newContexts.length === 0) {
      skipped++;
      continue;
    }

    const pageData = {
      word,
      seq:      existing?.seq ?? resolvedSeq,
      tags:     existing?.tags    ?? [],
      contexts: [...(existing?.contexts ?? []), ...newContexts],
      image:    existing?.image   ?? '',
      notes:    existing?.notes   ?? '',
    };

    const action = existing ? 'update' : 'create';

    if (dryRun) {
      console.log(`[${action}] ${word}  seq=${pageData.seq ?? 'none'}  +${newContexts.length} context(s)`);
    } else {
      await wiki.saveWordPage(word, pageData);
      console.log(`[${action}] ${word}  seq=${pageData.seq ?? 'none'}  +${newContexts.length} context(s)`);
    }
    if (existing) updated++; else created++;
    if (created >= limit) { console.log(`\nLimit of ${limit} reached, stopping.`); break; }
  }

  console.log(`\nDone.  Created: ${created}  Updated: ${updated}  Skipped (no new contexts): ${skipped}`);
}

main().catch(err => { console.error(err); process.exit(1); });
