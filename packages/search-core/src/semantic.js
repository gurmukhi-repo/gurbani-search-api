'use strict';
/**
 * Semantic retrieval over the precomputed vector indexes.
 *
 * Every function here except searchText() runs with NO model present: the query
 * is an item already in the corpus, so its vector is a lookup. That is what
 * makes line->line and shabad->shabad fully deterministic and API-free.
 */

const DEFAULT_K = 10;

/** Lines that mean the same thing as this line. */
function similarLines(art, lineId, k = DEFAULT_K, opts = {}) {
  return art.lines.similarTo(lineId, k, opts);
}

/** Shabads about the same thing as this shabad (rahao-weighted vectors). */
function similarShabads(art, shabadId, k = DEFAULT_K, opts = {}) {
  return art.shabads.similarTo(shabadId, k, opts);
}

/**
 * Shabads sharing this shabad's central theme, comparing rahao to rahao only.
 * Returns [] for a shabad with no rahao -- which is the majority of them.
 */
function similarByRahao(art, shabadId, k = DEFAULT_K, opts = {}) {
  if (art.rahao.rowOf(shabadId) < 0) return [];
  return art.rahao.similarTo(shabadId, k, opts);
}

/** Free-text search. `queryVec` must already be PCA-projected and normalized. */
function searchText(art, queryVec, level = 'lines', k = DEFAULT_K, opts = {}) {
  const index = { lines: art.lines, shabads: art.shabads, rahao: art.rahao }[level];
  if (!index) throw new Error(`unknown level: ${level}`);
  return index.search(queryVec, k, opts);
}

module.exports = { similarLines, similarShabads, similarByRahao, searchText, DEFAULT_K };
