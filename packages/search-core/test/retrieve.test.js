'use strict';
/**
 * Retrieval fusion for "ask": deterministic, index-agnostic candidate shabads.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../src/index-node.js');
const { fuse, fuseBy, fuseSimilar, RRF_K } = require('../src/retrieve.js');

const ROOT = process.env.ROOT_DIR || path.resolve(__dirname, '..', '..', '..');
const ARTIFACTS = process.env.ARTIFACTS_DIR || path.join(ROOT, 'artifacts');
const CORPUS = process.env.CORPUS_DB || path.join(ROOT, 'data', 'corpus.sqlite');
const INDEXES = { en: ARTIFACTS, pa: path.join(ARTIFACTS, 'pa') };
const HAS = Object.fromEntries(Object.entries(INDEXES).map(([n, d]) => [n, fs.existsSync(path.join(d, 'manifest.json'))]));
const HAS_DB = fs.existsSync(CORPUS);

test('fuse: one vote per list, reciprocal rank, ties on ascending shabad id', () => {
  const lists = [
    { index: 'en', via: 'line', items: [{ id: 1, shabad_id: 10, score: 0.9 }, { id: 2, shabad_id: 10, score: 0.8 }, { id: 3, shabad_id: 20, score: 0.7 }] },
    { index: 'en', via: 'shabad', items: [{ id: 20, shabad_id: 20, score: 0.6 }, { id: 30, shabad_id: 30, score: 0.5 }] },
  ];
  const out = fuse(lists, 10);
  // shabad 10: rank 1 in list A only (the second line of the same shabad does not vote again)
  // shabad 20: rank 3 in A + rank 1 in B; shabad 30: rank 2 in B
  const score = m => Object.fromEntries(out.map(o => [o.shabad_id, o.score]))[m];
  assert.ok(Math.abs(score(10) - 1 / (RRF_K + 1)) < 1e-6);
  assert.ok(Math.abs(score(20) - (1 / (RRF_K + 3) + 1 / (RRF_K + 1))) < 1e-6);
  assert.deepStrictEqual(out.map(o => o.shabad_id), [20, 10, 30]);
  assert.strictEqual(out[1].hits.length, 1, 'a shabad votes once per list');
});

test('fuse: a list votes with its weight; weight 0 does not vote; unweighted lists count 1', () => {
  const items = [{ id: 1, shabad_id: 10, score: 0.9 }];
  const one = fuse([{ index: 'a', via: 'x', items }], 5)[0].score;
  const two = fuse([{ index: 'a', via: 'x', weight: 2, items }], 5)[0].score;
  assert.ok(Math.abs(two - 2 * one) < 1e-6, 'weight 2 doubles the vote');
  assert.deepStrictEqual(fuse([{ index: 'a', via: 'x', weight: 0, items }], 5), [], 'weight 0 is silence');
  const mixed = fuse([{ index: 'a', via: 'x', weight: 0, items: [{ id: 1, shabad_id: 10, score: 1 }] },
                      { index: 'b', via: 'x', items: [{ id: 2, shabad_id: 20, score: 1 }] }], 5);
  assert.deepStrictEqual(mixed.map(o => o.shabad_id), [20]);
  assert.strictEqual(mixed[0].hits.length, 1);
});

test('fuseBy keys on anything; fuseSimilar fuses one lookup across indexes by id', () => {
  const byId = fuseBy([{ index: 'a', via: 's', items: [{ id: 7, score: 1 }, { id: 3, score: 0.5 }] },
                       { index: 'b', via: 's', items: [{ id: 3, score: 1 }] }], 10, it => it.id);
  assert.deepStrictEqual(byId.map(r => r.key), [3, 7], 'id 3 is in both lists');
  assert.strictEqual(byId[0].hits.length, 2);
  const artA = { tag: 'A' }, artB = { tag: 'B' };
  const run = (art, depth) => (art.tag === 'A' ? [{ id: 1, score: 1 }, { id: 2, score: 0.9 }] : [{ id: 2, score: 1 }]).slice(0, depth);
  const out = fuseSimilar({ entries: [{ name: 'b', art: artB }, { name: 'a', art: artA, weight: 1 }], run, k: 5 });
  assert.deepStrictEqual(out.map(r => r.id), [2, 1], 'the id both indexes return comes first');
  assert.deepStrictEqual(out[0].hits.map(h => h.index), ['a', 'b'], 'lists are visited in name order, deterministically');
  const again = fuseSimilar({ entries: [{ name: 'a', art: artA }, { name: 'b', art: artB }], run, k: 5 });
  assert.deepStrictEqual(again, out);
});

test('fuse: equal scores break ties on ascending shabad id, and k truncates', () => {
  const lists = [{ index: 'x', via: 'y', items: [{ id: 1, shabad_id: 7, score: 1 }] },
                 { index: 'x', via: 'z', items: [{ id: 2, shabad_id: 3, score: 1 }] }];
  assert.deepStrictEqual(fuse(lists, 10).map(o => o.shabad_id), [3, 7]);
  assert.strictEqual(fuse(lists, 1).length, 1);
});

/** A float query from a stored int8 row -- the vector of an existing line. */
function rowVector(index, row) {
  const { dim, codes, scales } = index;
  const v = new Float32Array(dim);
  let n = 0;
  for (let i = 0; i < dim; i += 1) { v[i] = codes[row * dim + i] * scales[row]; n += v[i] * v[i]; }
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < dim; i += 1) v[i] /= n;
  return v;
}

test('retrieveShabads: every loaded index votes, results are sorted, and it is deterministic',
  { skip: !HAS.en || !HAS_DB }, async () => {
    const indexes = {};
    for (const [n, d] of Object.entries(INDEXES)) if (HAS[n]) indexes[n] = await core.loadArtifacts(core.nodeReadFile(d));
    const db = core.openNodeAdapter(CORPUS);
    const shabadOfLines = ids => new Map(db.all(
      `SELECT line_id, shabad_id FROM lines WHERE line_id IN (${ids.map(() => '?').join(',')})`, ids)
      .map(r => [r.line_id, r.shabad_id]));
    const queryVecs = Object.fromEntries(Object.entries(indexes).map(([n, art]) => [n, rowVector(art.lines, 4000)]));
    const a = core.retrieveShabads({ indexes, queryVecs, shabadOfLines, k: 20 });
    const b = core.retrieveShabads({ indexes, queryVecs, shabadOfLines, k: 20 });
    assert.deepStrictEqual(a, b, 'deterministic');
    assert.strictEqual(a.length, 20);
    const votingIndexes = new Set(a.flatMap(s => s.hits.map(h => h.index)));
    assert.deepStrictEqual([...votingIndexes].sort(), Object.keys(indexes).sort(), 'every loaded index contributed');
    assert.ok(a.every((s, i) => i === 0 || s.score <= a[i - 1].score), 'sorted by fused score');
    db.close();
  });

test('retrieveShabads: a line always retrieves its own shabad, and usually ranks it first',
  { skip: !HAS.en || !HAS_DB }, async () => {
    // "Own shabad ranks first" is NOT an invariant and never was: measured over
    // 400 lines it holds 51% of the time with these two indexes (67% with all
    // three), because a shabad whose refrain is closer to the query
    // legitimately outranks the one the line came from. What IS invariant is
    // that the line's own shabad is always among the candidates -- 400 of 400,
    // under every weighting tried. The rate is asserted only as a floor, to
    // catch a fusion that has stopped preferring the own shabad at all; a
    // single hand-picked line catches neither.
    const indexes = {};
    for (const [n, d] of Object.entries(INDEXES)) if (HAS[n]) indexes[n] = await core.loadArtifacts(core.nodeReadFile(d));
    const db = core.openNodeAdapter(CORPUS);
    const shabadOfLines = ids => new Map(db.all(
      `SELECT line_id, shabad_id FROM lines WHERE line_id IN (${ids.map(() => '?').join(',')})`, ids)
      .map(r => [r.line_id, r.shabad_id]));
    const all = db.all("SELECT line_id, shabad_id FROM lines WHERE kind IN ('line','rahao') ORDER BY line_id", []);
    const step = Math.floor(all.length / 40);
    const sample = all.filter((_, i) => i % step === 0).slice(0, 40);
    let first = 0;
    for (const { line_id: lineId, shabad_id: own } of sample) {
      const queryVecs = Object.fromEntries(
        Object.entries(indexes).map(([n, art]) => [n, rowVector(art.lines, lineId)]));
      const out = core.retrieveShabads({ indexes, queryVecs, shabadOfLines, k: 20 });
      const rank = out.findIndex(s => s.shabad_id === own);
      assert.ok(rank >= 0, `line ${lineId} did not retrieve its own shabad ${own}`);
      if (rank === 0) first += 1;
    }
    assert.ok(first / sample.length >= 0.35,
      `own shabad ranked first for only ${first}/${sample.length}`);
    db.close();
  });

test('retrieveShabads: an index without a query vector is skipped', { skip: !HAS.en }, async () => {
  const en = await core.loadArtifacts(core.nodeReadFile(INDEXES.en));
  const out = core.retrieveShabads({ indexes: { en, pa: en }, queryVecs: { en: rowVector(en.lines, 100) },
                                     shabadOfLines: () => new Map(), k: 5 });
  assert.ok(out.length > 0);
  assert.ok(out.every(s => s.hits.every(h => h.index === 'en')));
});
