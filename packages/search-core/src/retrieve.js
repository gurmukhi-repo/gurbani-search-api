'use strict';
/**
 * Candidate shabads for a question -- the retrieval half of "ask" -- and the
 * fusion that lets several meaning indexes answer one request.
 *
 * Every index contributes what it is good at: line search (a single line that
 * answers the question), shabad search (a whole shabad about it) and rahao
 * search (a shabad whose thesis is it). The lists are merged with reciprocal
 * rank fusion, which needs no score calibration between indexes built by
 * different models. Each list carries a weight -- an index's manifest says
 * how much its vote counts -- so adding an index cannot silently drown the
 * others: a weight of 0 is a list that does not vote.
 *
 * Deterministic: exhaustive scans, fixed list order, ties broken on
 * ascending id. A language model reads the result; nothing here does.
 */
const { similarLines, similarShabads, similarByRahao, searchText } = require('./semantic.js');

const RRF_K = 60;

/**
 * @param {object} opts
 * @param {object} opts.indexes   {en: art, pa: art} -- whichever are loaded
 * @param {object} opts.queryVecs {en: Float32Array|Float32Array[], ...} -- PCA-projected
 *   query vectors per index (others are skipped); several for one index vote separately
 * @param {function} opts.shabadOfLines  (lineIds) => Map(lineId -> shabadId)
 * @param {number} [opts.k=20]  how many shabads to return
 * @param {number} [opts.depth=40]  how deep each list goes before fusion
 * @param {object} [opts.weights]  {en: 1, pa: 0.5} -- an index's vote; default 1
 * @returns {Array<{shabad_id, score, hits: Array<{index, via, rank, id, score}>}>}
 */
function retrieveShabads({ indexes, queryVecs, shabadOfLines, k = 20, depth = 40, weights = {} }) {
  const lists = [];
  for (const name of Object.keys(indexes).sort()) {
    const art = indexes[name];
    // one vector, or several -- the question and the search phrases planned
    // from it -- each voting on its own
    const vecs = Array.isArray(queryVecs[name]) ? queryVecs[name] : (queryVecs[name] ? [queryVecs[name]] : []);
    if (!art) continue;
    const weight = weightOf(weights, name);
    vecs.forEach((vec, v) => {
      const tag = vecs.length > 1 ? `:q${v}` : '';
      const lineHits = searchText(art, vec, 'lines', depth);
      const owner = shabadOfLines(lineHits.map(h => h.id));
      lists.push({ index: name, via: `line${tag}`, weight, items: lineHits.map(h => ({ ...h, shabad_id: owner.get(h.id) })) });
      lists.push({ index: name, via: `shabad${tag}`, weight, items: searchText(art, vec, 'shabads', depth).map(h => ({ ...h, shabad_id: h.id })) });
      lists.push({ index: name, via: `rahao${tag}`, weight, items: searchText(art, vec, 'rahao', depth).map(h => ({ ...h, shabad_id: h.id })) });
    });
  }
  return fuse(lists, k);
}

/** Candidates for "more like this shabad" -- the same fusion over item lookups. */
function relatedShabads({ indexes, shabadId, shabadOfLines, lineIds = [], k = 20, depth = 40, weights = {} }) {
  const lists = [];
  for (const name of Object.keys(indexes).sort()) {
    const art = indexes[name];
    if (!art) continue;
    const weight = weightOf(weights, name);
    for (const lid of lineIds) {
      const hits = similarLines(art, lid, depth);
      const owner = shabadOfLines(hits.map(h => h.id));
      lists.push({ index: name, via: `line:${lid}`, weight, items: hits.map(h => ({ ...h, shabad_id: owner.get(h.id) })) });
    }
    lists.push({ index: name, via: 'shabad', weight, items: similarShabads(art, shabadId, depth).map(h => ({ ...h, shabad_id: h.id })) });
    lists.push({ index: name, via: 'rahao', weight, items: similarByRahao(art, shabadId, depth).map(h => ({ ...h, shabad_id: h.id })) });
  }
  return fuse(lists, k).filter(s => s.shabad_id !== shabadId);
}

/**
 * One lookup run against several indexes and fused: "similar lines from every
 * source", "similar shabads from every source". `run(art)` returns that
 * index's hits ({id, score}); the result is keyed by id.
 * @param {object} opts
 * @param {Array<{name: string, art: object, weight?: number}>} opts.entries
 * @param {function} opts.run  (art) => Array<{id, score}>
 * @param {number} [opts.k=10]
 * @param {number} [opts.depth]  how deep each index's list goes; default 3k
 * @returns {Array<{id, score, hits: Array<{index, via, rank, id, score}>}>}
 */
function fuseSimilar({ entries, run, k = 10, depth = k * 3 }) {
  const lists = [];
  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    let hits;
    try { hits = run(e.art, depth); } catch { hits = []; }
    lists.push({ index: e.name, via: 'similar', weight: e.weight, items: hits });
  }
  return fuseBy(lists, k, item => item.id).map(r => ({ id: r.key, score: r.score, hits: r.hits }));
}

const weightOf = (weights, name) => (Number.isFinite(weights[name]) ? weights[name] : 1);

/**
 * Reciprocal rank fusion, one vote per (list, key): the best rank a key
 * reaches in each list, scaled by the list's weight. Lists with weight 0 or
 * below are skipped.
 */
function fuseBy(lists, k, keyOf) {
  const byKey = new Map();
  for (const list of lists) {
    const weight = Number.isFinite(list.weight) ? list.weight : 1;
    if (weight <= 0) continue;
    const seen = new Set();
    list.items.forEach((item, rank) => {
      const key = keyOf(item);
      if (key === undefined || key === null || seen.has(key)) return;
      seen.add(key);
      const entry = byKey.get(key) || { key, score: 0, hits: [] };
      entry.score += weight / (RRF_K + rank + 1);
      entry.hits.push({ index: list.index, via: list.via, rank: rank + 1, id: item.id, score: item.score });
      byKey.set(key, entry);
    });
  }
  return [...byKey.values()]
    .map(e => ({ ...e, score: Math.round(e.score * 1e6) / 1e6 }))
    .sort((a, b) => (b.score - a.score) || (a.key - b.key))
    .slice(0, k);
}

/** Fusion keyed by shabad, the shape "ask" reads. */
function fuse(lists, k) {
  return fuseBy(lists, k, item => item.shabad_id).map(r => ({ shabad_id: r.key, score: r.score, hits: r.hits }));
}

module.exports = { retrieveShabads, relatedShabads, fuseSimilar, fuse, fuseBy, RRF_K };
