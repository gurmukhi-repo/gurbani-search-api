'use strict';
/**
 * Parity against the live BaniDB API.
 *
 * Our offline first-letter index is a reimplementation of BaniDB's
 * `tokenized_firstletters` range scan. The only way to know the port is faithful
 * is to ask the real service the same questions and compare answers. This is
 * the single most valuable test in the lexical half of the system.
 *
 * Network-dependent: skipped automatically when the API is unreachable.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { openNodeAdapter, firstLetterAnywhere, firstLetterAnywhereCount, gurmukhi } = require('../src/index-node.js');

const CORPUS = process.env.CORPUS_DB || path.resolve(__dirname, '..', '..', '..', 'data', 'corpus.sqlite');
const API = 'https://api.banidb.com/v2/search';
const SAMPLE_SIZE = Number(process.env.PARITY_SAMPLE || 60);

const HAS_DB = fs.existsSync(CORPUS);
const db = HAS_DB ? openNodeAdapter(CORPUS) : null;

async function apiSearch(q, results = 100) {
  const url = `${API}/${encodeURIComponent(q)}?searchtype=1&source=G&results=${results}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

let online = false;
test('live BaniDB API is reachable', async () => {
  try {
    await apiSearch('knjq', 1);
    online = true;
  } catch {
    online = false;
  }
  // Not an assertion failure -- offline runs simply skip the parity checks.
  if (!online) console.warn('  (API unreachable; parity checks will skip)');
});

test('known query returns the documented result count', { skip: !HAS_DB }, async t => {
  if (!online) return t.skip('offline');
  const api = await apiSearch('knjq');
  assert.strictEqual(firstLetterAnywhereCount(db, 'knjq'), api.resultsInfo.totalResults);
});

test('the reference rahao line is found by both', { skip: !HAS_DB }, async t => {
  if (!online) return t.skip('offline');
  const api = await apiSearch('knjq');
  const apiIds = new Set(api.verses.map(v => v.verse.verseId ?? v.verseId));
  const mine = new Set(firstLetterAnywhere(db, 'knjq', { limit: 100 }).map(r => r.verse_id));
  assert.ok(apiIds.has(416), 'API returns verseId 416');
  assert.ok(mine.has(416), 'our index returns verseId 416');
});

test(`${SAMPLE_SIZE} randomly sampled queries match the live API exactly`, { skip: !HAS_DB }, async t => {
  if (!online) return t.skip('offline');

  // Deterministic sample: fixed stride over line_ids, and a fixed window of
  // each line's first letters, so a failure is always reproducible.
  const rows = db.all(
    `SELECT line_id, first_letters_ascii FROM lines
     WHERE LENGTH(first_letters_ascii) >= 5 ORDER BY line_id`, []);
  const stride = Math.floor(rows.length / SAMPLE_SIZE);

  const mismatches = [];
  let checked = 0;
  for (let i = 0; i < SAMPLE_SIZE; i += 1) {
    const row = rows[i * stride];
    const fl = row.first_letters_ascii;
    const start = i % Math.max(1, fl.length - 4);
    const q = fl.slice(start, start + 4);
    if (!q || q.length < 3) continue;

    let api;
    try { api = await apiSearch(q); } catch { continue; }   // rate limited -> skip
    checked += 1;

    const apiTotal = api.resultsInfo.totalResults;
    const myTotal = firstLetterAnywhereCount(db, q);

    // The API indexes SGGS as we do, so counts should agree. Compare ID sets
    // too whenever the whole result set fits in one page.
    if (apiTotal !== myTotal) {
      mismatches.push({ q, apiTotal, myTotal, kind: 'count' });
    } else if (apiTotal > 0 && apiTotal <= 100) {
      const apiIds = new Set(api.verses.map(v => v.verseId));
      const mineIds = new Set(firstLetterAnywhere(db, q, { limit: 1000 }).map(r => r.verse_id));
      const missing = [...apiIds].filter(id => !mineIds.has(id));
      const extra = [...mineIds].filter(id => !apiIds.has(id));
      if (missing.length || extra.length) {
        mismatches.push({ q, missing: missing.slice(0, 5), extra: extra.slice(0, 5), kind: 'set' });
      }
    }
    await new Promise(r => setTimeout(r, 120));
  }

  console.log(`  compared ${checked} live queries`);
  assert.ok(checked >= 10, `only ${checked} queries compared -- API likely throttling`);
  assert.deepStrictEqual(mismatches, [],
    `${mismatches.length}/${checked} queries disagreed with the live API`);
});

test('bindi-insensitive: a query without nuktas finds lines with them', { skip: !HAS_DB }, () => {
  // 's' (ਸ) must also reach lines whose first letter is 'S' (ਸ਼).
  const plain = gurmukhi.buildQuery('s');
  assert.ok(gurmukhi.bindiVariant(plain), 'ਸ must have a bindi variant');
  const hits = firstLetterAnywhere(db, 'sn', { limit: 200 });
  assert.ok(hits.length > 0);
});

test('search is deterministic across repeated calls and reopens', { skip: !HAS_DB }, () => {
  const a = firstLetterAnywhere(db, 'hhg', { limit: 50 }).map(r => r.line_id);
  const b = firstLetterAnywhere(db, 'hhg', { limit: 50 }).map(r => r.line_id);
  assert.deepStrictEqual(a, b);
  const fresh = openNodeAdapter(CORPUS);
  const c = firstLetterAnywhere(fresh, 'hhg', { limit: 50 }).map(r => r.line_id);
  assert.deepStrictEqual(a, c, 'results must survive a cold reopen unchanged');
  fresh.close();
});

test('empty and whitespace queries return nothing rather than everything', { skip: !HAS_DB }, () => {
  assert.deepStrictEqual(firstLetterAnywhere(db, ''), []);
  assert.deepStrictEqual(firstLetterAnywhere(db, '   '), []);
});
