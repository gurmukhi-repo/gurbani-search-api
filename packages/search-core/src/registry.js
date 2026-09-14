'use strict';
/**
 * What a manifest means, without reading one.
 *
 * An index is a directory with a manifest.json. The pipeline writes it; this
 * module answers the questions the server and the client ask of an index that an
 * older manifest may be too old to answer:
 *
 *   what to call it        label, label_pa
 *   what it embedded       text_source (real source ids), text_lang, enriched
 *   what it can read       query_scripts -- a query in Gurmukhi needs an index
 *                          whose model reads Gurmukhi; the English one does not
 *   what it is for         roles: neighbours (similar lines/shabads/rahao),
 *                          text (free-text search), ask (retrieval for Ask);
 *                          [] marks a lab candidate that never loads
 *   how much it says       ask_weight, when several indexes vote
 *   where it sits          order, in the switch a reader sees
 *
 * Every function here is pure. FINDING the manifests is a separate job, left in
 * apps/web/registry.js, because that reads a directory with node:fs and a phone
 * has no directory to read -- it is handed the manifests inlined in the bundle
 * manifest instead. Splitting the two is what lets a device share this half
 * verbatim rather than reimplementing the defaults and drifting from them.
 *
 * Nothing here knows an index by name.
 */
const GURMUKHI = /[਀-੿]/;
const ALL_ROLES = ['neighbours', 'text', 'ask'];

/** Read a manifest's presentation fields, filling in what an older manifest lacks. */
function normalizeManifest(m) {
  const name = m.index || 'en';
  const textSource = m.text_source === 'translations' ? 'ssk,bdb,ms' : (m.text_source || 'unknown');
  const textLang = m.text_lang || (textSource === 'gurmukhi_uni' ? 'pa' : 'en');
  const queryScripts = Array.isArray(m.query_scripts) && m.query_scripts.length
    ? m.query_scripts : (textLang === 'pa' ? ['gurmukhi', 'latin'] : ['latin']);
  const roles = Array.isArray(m.roles) ? m.roles.filter(r => ALL_ROLES.includes(r)) : [...ALL_ROLES];
  const enriched = m.enriched === true ? 'kosh' : (m.enriched === false || m.enriched == null ? 'none' : String(m.enriched));
  return {
    name,
    label: m.label || name,
    label_pa: m.label_pa || null,
    text_source: textSource,
    text_lang: textLang,
    query_scripts: queryScripts,
    roles,
    ask_weight: Number.isFinite(m.ask_weight) ? m.ask_weight : 1,
    order: Number.isFinite(m.order) ? m.order : 100,
    enriched,
    source: m.source || { translators: textSource.split(','), origin: null, machine_translated: false, engine: null, model: null },
    lines_with_text: Number.isFinite(m.lines_with_text) ? m.lines_with_text : (m.semantic_lines ?? null),
    model: m.model || null,
    // translator agreement recorded by 09_agreement.py, if any: {against: {mean, p10, ...}}
    agreement: m.agreement && typeof m.agreement === 'object' ? m.agreement : null,
  };
}

/** Can this index embed this query? Gurmukhi text needs a model that reads Gurmukhi. */
function canRead(meta, text) {
  return GURMUKHI.test(String(text)) ? meta.query_scripts.includes('gurmukhi') : meta.query_scripts.includes('latin');
}

/** Names in the order the reader sees them: by `order`, then by name. */
function orderIndexes(entries) {
  return Object.entries(entries)
    .sort(([na, a], [nb, b]) => (a.meta.order - b.meta.order) || na.localeCompare(nb))
    .map(([n]) => n);
}

/** The health row for one index. */
function summarize(entry) {
  const m = entry.meta;
  return {
    loaded: true,
    freeText: Boolean(entry.encoder),
    model: m.model,
    text_source: m.text_source,
    text_lang: m.text_lang,
    enriched: m.enriched,
    label: m.label,
    label_pa: m.label_pa,
    query_scripts: m.query_scripts,
    roles: m.roles,
    ask_weight: m.ask_weight,
    order: m.order,
    lines_with_text: m.lines_with_text,
    source: m.source,
    agreement: m.agreement,
  };
}

module.exports = { normalizeManifest, canRead, orderIndexes, summarize, ALL_ROLES };
