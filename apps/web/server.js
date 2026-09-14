'use strict';
/**
 * Server for the Gurbani app.
 *
 * Any number of meaning indexes load side by side and the client picks one per
 * request (?index=<name>). An index is a directory under artifacts/ with a
 * manifest (the English one at the root); the manifest says what text it
 * embedded, with which model, what it is called, which scripts a query may be
 * in and what it is for -- see registry.js. Nothing here knows an index by
 * name: adding one is adding a directory. The server builds each index's query
 * encoder from its manifest, sharing one ONNX session per model.
 *
 * Semantic endpoints degrade to 503 when an index is absent -- lexical search
 * must never depend on them. That isolation is asserted in search-core's tests
 * and mirrored here.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../../packages/search-core/src/index-node.js');

const ROOT = path.resolve(__dirname, '..', '..');
const ARTIFACTS = process.env.ARTIFACTS_DIR || path.join(ROOT, 'artifacts');
// The slim shipping database: everything a client searches, and nothing it
// does not. Translations live in their own file (below) because they are read
// a shabad at a time rather than searched.
const DB_PATH = process.env.DB_PATH || path.join(ARTIFACTS, 'gurbani.sqlite');
const MODELS_DIR = process.env.MODELS_DIR || path.join(ROOT, 'vendor', 'models');
// English and Punjabi translations, kept out of the shipping database because
// they are read a shabad at a time rather than searched. Two readers: the ask
// feature, which hands a shabad's meaning to the language model, and the reader
// who turns on translations beside the Gurmukhi (?tr=en,pa). Absent -> ask is
// off and the translation toggle is not offered.
const TRANSLATIONS_PATH = process.env.TRANSLATIONS_PATH || path.join(ARTIFACTS, 'translations.sqlite');
const PORT = Number(process.env.PORT || 5173);
const PUBLIC_DIR = path.resolve(__dirname, 'public');
// When set, every route except /api/health requires HTTP Basic auth with this
// password (any username). Unset for local development.
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const IS_PROD = process.env.NODE_ENV === 'production';

// Indexes are discovered, not listed: every directory under artifacts/ with a
// manifest, the English one at the root. A manifest with `roles: []` is a lab
// candidate and never loads; INDEXES=a,b in the environment restricts the set.
const registry = require('./registry.js');
// The index a request gets when it names none. Resolved after loading rather
// than fixed here, because a deployment that restricts INDEXES (a semantic-API
// microservice ships one index, not five) would otherwise 400 every unnamed
// request against a default that was never loaded.
const CONFIGURED_DEFAULT = process.env.DEFAULT_INDEX || 'en-ss';
let DEFAULT_INDEX = CONFIGURED_DEFAULT;
const ONLY = (process.env.INDEXES || '').split(',').map(x => x.trim()).filter(Boolean);

// Refuse to start without the database. A server that answers /api/health
// with 200 and every search with 503 would pass the host's health check while
// being useless -- fail here so a bad deploy is visible.
if (!fs.existsSync(DB_PATH)) {
  console.error(`database not found: ${DB_PATH}\n`
    + 'build it with: node pipeline/node/src/05-build-shipping-db.js');
  process.exit(1);
}
const db = core.openNodeAdapter(DB_PATH);

/** name -> { art, encoder, meta } for every index that loaded; `known` also holds the eligible ones that did not. */
const indexes = {};
const known = new Set();
let tdb = null;          // translations.sqlite, when it is on disk

// Who is asking, and how much they have left. The limiter above stays the
// burst guard -- in memory, per minute -- while the durable daily counters
// live in accounts/quota.js, because this machine stops when it is idle.
// The public export swaps identity.js for a Basic-auth-only file of the same
// shape and the same path, so the credential gate below needs no change.
const identify = require('./accounts/identity.js').createIdentifier();

// Cross-origin access, off unless CORS_ORIGINS is set. With it unset this adds
// no header to any response and leaves OPTIONS a 405, exactly as before.
const cors = require('./cors.js').createCors();

// Per-client request limits, off unless RATE_LIMIT_PER_MINUTE is set.
const limits = require('./limits.js').createLimits();

async function tryLoadIndex(name, dir) {
  try {
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) return null;
    const art = await core.loadArtifacts(core.nodeReadFile(dir));
    console.log(`index "${name}": ${art.lines.n} lines, ${art.shabads.n} shabads, `
      + `${art.rahao.n} rahao, dim ${art.manifest.index_dim}, ${art.manifest.model}`);
    // per-line translator agreement, when 09_agreement.py has run for this index:
    // agreement.<against>.f32, one float per line, NaN where either side is missing
    const agreement = {};
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^agreement\.(.+)\.f32$/);
      if (m) agreement[m[1]] = new Float32Array(fs.readFileSync(path.join(dir, f)).buffer.slice(0));
    }
    if (Object.keys(agreement).length) console.log(`index "${name}": agreement vs ${Object.keys(agreement).join(', ')}`);
    return { art, encoder: null, agreement };
  } catch (err) {
    console.warn(`index "${name}" unavailable:`, err.message);
    return null;
  }
}

/**
 * The query encoder an index's manifest asks for; null means free text is off
 * for it. Indexes built with the same model share one ONNX session -- the
 * session is the memory, the index is only the prefixes and pooling around it.
 */
const encoders = new Map();      // model dir -> encoder
async function tryLoadEncoder(name, entry) {
  try {
    const { encoderOptions } = require('../../packages/query-encoder/src/index.js');
    const { createNodeEncoder } = require('../../packages/query-encoder/src/factory-node.js');
    const opts = encoderOptions(entry.art.manifest);
    const modelDir = path.join(MODELS_DIR, opts.modelDir || 'bge-small-en-v1.5');
    if (!fs.existsSync(path.join(modelDir, 'model_quantized.onnx'))) {
      console.warn(`index "${name}": model ${path.relative(ROOT, modelDir)} missing, free-text search off`);
      return null;
    }
    const key = JSON.stringify([modelDir, opts.tokenizer, opts.pooling, opts.queryPrefix, opts.maxLen]);
    if (!encoders.has(key)) {
      encoders.set(key, await createNodeEncoder(modelDir, opts));
      console.log(`index "${name}": query encoder loaded (${opts.tokenizer}, ${opts.pooling} pooling)`);
    } else {
      console.log(`index "${name}": query encoder shared`);
    }
    return encoders.get(key);
  } catch (err) {
    console.warn(`index "${name}": query encoder unavailable:`, err.message);
    return null;
  }
}

const lineCols = `line_id, verse_id, shabad_id, ang, position_in_shabad,
                  gurmukhi_uni, gurmukhi_ascii, translit_roman, first_letters_ascii,
                  kind, rahao_kind, writer, raag`;

// Views a reader can ask to see beside a line (?tr=en,pa,pad,fk), each a list
// of translator ids, best first: a line takes the first one that has it.
//   en   English translation -- BaniDB's corrected edition of Sant Singh Khalsa,
//        else Manmohan Singh. The uncorrected `ssk` text stays in the file but
//        is not shown: where the two differ, the correction is the point.
//   pa   Punjabi arth -- Sahib Singh's Darpan, the standard exegesis, which
//        stops short of 5,300 lines where Manmohan Singh's Punjabi fills in
//   pad  Sahib Singh's pad-arth: the hard words of the line, each with its meaning
//   fk   Faridkot Teeka -- the sampradayak reading
//
// The Darpan's machine English (en-ss-mt, en-ss-pad-mt) is deliberately NOT a
// view. A machine rendering of Sahib Singh is good enough to retrieve with and
// to hand a model as context, and not good enough to put in front of a reader
// as his words. It serves the English meaning indexes and Ask, both of which
// read translations.sqlite directly, and it stops there.
const TRANSLATORS = { en: ['bdb', 'ms'], pa: ['pa-ss', 'pa-ms'], pad: ['pa-ss-pad'], fk: ['pa-fk'] };

/** Views a request asked to see beside the Gurmukhi: ?tr=en,pa,pad,fk */
function parseLangs(url) {
  if (!tdb) return [];
  const raw = (url.searchParams.get('tr') || '').split(',').map(x => x.trim()).filter(Boolean);
  return raw.filter(l => l in TRANSLATORS);
}

/**
 * Add `tr_en` / `tr_pa` to line rows, in place, for the languages asked for.
 * One query for a whole page of results; a line with no translation simply
 * carries none.
 */
function attachTranslations(rows, langs) {
  if (!langs.length || !rows.length) return rows;
  const wanted = new Set(langs.flatMap(l => TRANSLATORS[l]));
  const ids = rows.map(r => r.line_id);
  const found = tdb.all(
    `SELECT line_id, translator, text FROM translations WHERE line_id IN (${ids.map(() => '?').join(',')})`, ids);
  const byLine = new Map();
  for (const t of found) {
    if (!wanted.has(t.translator)) continue;
    if (!byLine.has(t.line_id)) byLine.set(t.line_id, {});
    byLine.get(t.line_id)[t.translator] = t.text;
  }
  for (const row of rows) {
    const got = byLine.get(row.line_id) || {};
    for (const lang of langs) {
      const pick = TRANSLATORS[lang].find(t => got[t]);
      if (pick) row[`tr_${lang}`] = got[pick];
    }
  }
  return rows;
}

/**
 * Add `agreement: {<against>: cosine}` to line rows from an index that has
 * measured how far its translators sit apart on each line. A low value is
 * the one place a reader should not trust any single translation.
 */
function attachAgreement(rows, entry) {
  if (!entry || !entry.agreement || !Object.keys(entry.agreement).length) return rows;
  for (const row of rows) {
    const out = {};
    for (const [against, arr] of Object.entries(entry.agreement)) {
      const v = arr[row.line_id];
      if (Number.isFinite(v)) out[against] = Math.round(v * 1000) / 1000;
    }
    if (Object.keys(out).length) row.agreement = out;
  }
  return rows;
}

// translations.sqlite is built in stages, so ask before reading: a file built
// before 09-ingest-darpan.js ran has neither of these tables.
const tdbTables = new Map();
function tdbHas(table) {
  if (!tdb) return false;
  if (!tdbTables.has(table)) {
    tdbTables.set(table, tdb.all(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [table]).length > 0);
  }
  return tdbTables.get(table);
}

/**
 * What the Darpan says ABOUT a shabad, as opposed to line by line: the ਭਾਵ
 * gist Sahib Singh wrote for it, the arth of each stanza, and the subject he
 * filed it under in his ਗੁਰਮਤਿ ਅੰਗ ਸੰਗ੍ਰਹਿ index. All three exist only for the
 * shabads the docx reaches; a shabad without them simply gets nulls.
 */
function darpanContext(shabadId) {
  if (!tdbHas('darpan_units')) return null;
  const units = tdb.all(
    "SELECT unit_id, kind, stanza, is_rahao, en, en_covers, text FROM darpan_units"
    + " WHERE shabad_id = ? AND kind IN ('arth','bhav') ORDER BY rowid", [shabadId]);
  const bhav = units.find(u => u.kind === 'bhav') || null;
  const stanzas = units.filter(u => u.kind === 'arth').map(u => ({
    stanza: u.stanza, is_rahao: Boolean(u.is_rahao), pa: u.text, en: u.en,
    covers: Math.max(1, Number(u.en_covers) || 1),
  }));
  const topics = tdbHas('darpan_topics')
    ? tdb.all('SELECT topic, sub, gist, gist_en FROM darpan_topics WHERE shabad_id = ? ORDER BY code', [shabadId])
    : [];
  if (!bhav && !stanzas.length && !topics.length) return null;
  return {
    bhav: bhav ? { pa: bhav.text, en: bhav.en } : null,
    stanzas,
    topics: topics.map(t => ({ topic: t.topic, sub: t.sub, pa: t.gist, en: t.gist_en })),
  };
}

/** Which languages this build can show, for /api/health. */
function availableLangs() {
  if (!tdb) return {};
  return Object.fromEntries(Object.keys(TRANSLATORS).map(lang => [lang, tdb.all(
    `SELECT 1 FROM translations WHERE translator IN (${TRANSLATORS[lang].map(() => '?').join(',')}) LIMIT 1`,
    TRANSLATORS[lang]).length > 0]));
}

const linesByIds = ids => {
  if (!ids.length) return [];
  const rows = db.all(
    `SELECT ${lineCols} FROM lines WHERE line_id IN (${ids.map(() => '?').join(',')})`, ids);
  const byId = new Map(rows.map(r => [r.line_id, r]));
  return ids.map(id => byId.get(id)).filter(Boolean);
};

const shabadsByIds = ids => {
  if (!ids.length) return [];
  const rows = db.all(
    `SELECT s.shabad_id, s.writer, s.raag, s.ang_start, s.line_count, s.has_rahao,
            (SELECT gurmukhi_uni FROM lines l WHERE l.shabad_id=s.shabad_id AND l.kind='rahao'
              ORDER BY position_in_shabad LIMIT 1) AS rahao_line,
            (SELECT gurmukhi_uni FROM lines l WHERE l.shabad_id=s.shabad_id AND l.kind IN ('line','rahao')
              ORDER BY position_in_shabad LIMIT 1) AS first_line
     FROM shabads s WHERE s.shabad_id IN (${ids.map(() => '?').join(',')})`, ids);
  const byId = new Map(rows.map(r => [r.shabad_id, r]));
  return ids.map(id => byId.get(id)).filter(Boolean);
};

function parseBoundedInt(val, min, max, fallback) {
  const n = Number(val);
  return Number.isInteger(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function parseNonNegativeInt(val) {
  const n = Number(val);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** The index a request asks for, or an error body: 400 for a name nobody has, 503 for one that did not load. */
function pickIndex(url) {
  const name = url.searchParams.get('index') || DEFAULT_INDEX;
  const entry = indexes[name];
  if (entry) return { name, entry };
  if (known.has(name)) return { error: `semantic index "${name}" not built`, code: 503 };
  return { error: `unknown index "${name}"`, code: 400 };
}

/**
 * `index=all`: every loaded index with the role, in display order.
 * `index=a,b,c`: those, fused the same way -- what the reader's "Gurmukhi" and
 * "English" groups send, so the switch can offer a language rather than a list
 * of build names.
 * `index=a`: that one alone.
 * Returns { names, entries } or an error body.
 */
function pickIndexes(url, role) {
  const name = url.searchParams.get('index') || DEFAULT_INDEX;
  if (name !== 'all' && name.includes(',')) {
    const wanted = [...new Set(name.split(',').map(x => x.trim()).filter(Boolean))];
    const missing = wanted.filter(n => !indexes[n]);
    if (missing.length) {
      const unbuilt = missing.filter(n => known.has(n));
      return unbuilt.length
        ? { error: `semantic index "${unbuilt[0]}" not built`, code: 503 }
        : { error: `unknown index "${missing[0]}"`, code: 400 };
    }
    const names = registry.orderIndexes(indexes).filter(n => wanted.includes(n)
      && indexes[n].meta.roles.includes(role));
    if (!names.length) return { error: `none of those indexes serve ${role}`, code: 400 };
    return { names, entries: names.map(n => indexes[n]), all: true };
  }
  if (name !== 'all') {
    const one = pickIndex(url);
    if (one.error) return one;
    // 'all' filters by role; one index by name did not, so a caller could ask
    // pa-ft for neighbours -- the role its own manifest says it does not serve,
    // because contrastive training left it last of ten at finding them
    if (!one.entry.meta.roles.includes(role)) {
      return { error: `index "${one.name}" does not serve ${role}`, code: 400 };
    }
    return { names: [one.name], entries: [one.entry], all: false };
  }
  const names = registry.orderIndexes(indexes).filter(n => indexes[n].meta.roles.includes(role));
  if (!names.length) return { error: `no loaded index serves ${role}`, code: 503 };
  return { names, entries: names.map(n => indexes[n]), all: true };
}

/**
 * A similar-* route: one index, or all of them fused by reciprocal rank
 * (`run(art, depth)` is the per-index lookup). Fused results carry `votes`,
 * how many sources agreed, in place of a cosine.
 */
const similar = (run, resolve) => url => {
  const picked = pickIndexes(url, 'neighbours');
  if (picked.error) return picked;
  const id = parseNonNegativeInt(url.searchParams.get('id'));
  if (id === null) return { error: 'invalid or missing id parameter', code: 400 };
  const k = parseBoundedInt(url.searchParams.get('k'), 1, 50, 10);
  if (!picked.all) return run.one(picked.names[0], picked.entries[0], id, k, url);
  const fused = core.fuseSimilar({ entries: picked.entries.map(e => ({ name: e.meta.name, art: e.art, weight: 1 })),
                                   run: (art, depth) => run.many(art, id, depth), k });
  const rows = resolve(fused.map(f => f.id), url);
  const byId = new Map(fused.map(f => [f.id, f]));
  return { index: 'all', indexes: picked.names, score_kind: 'rrf',
           results: rows.map(r => ({ ...r, score: byId.get(r.line_id ?? r.shabad_id).score, votes: byId.get(r.line_id ?? r.shabad_id).hits.length })) };
};


const routes = {
  '/api/health': () => {
    const sources = registry.orderIndexes(indexes);
    const summary = Object.fromEntries([...new Set([...known, ...sources])].map(name =>
      [name, indexes[name] ? registry.summarize(indexes[name]) : { loaded: false }]));
    return {
      ok: true,
      lines: db.all('SELECT COUNT(*) c FROM lines')[0].c,
      indexes: summary,
      // the reader's switch: loaded indexes in display order, and the one used when none is named
      sources,
      default_index: indexes[DEFAULT_INDEX] ? DEFAULT_INDEX : (sources[0] || null),
      translations: availableLangs(),
      // Reported because the alternative is a browser console message that does
      // not say whether the server was configured or the origin was refused.
      cors: cors.summary(),
      rate_limit: limits.summary(),
      // legacy summary fields, for the default index
      semantic: Boolean(indexes[DEFAULT_INDEX]),
      freeText: Boolean(indexes[DEFAULT_INDEX] && indexes[DEFAULT_INDEX].encoder),
    };
  },

  '/api/fl': url => {
    const q = url.searchParams.get('q') || '';
    const limit = parseBoundedInt(url.searchParams.get('limit'), 1, 100, 25);
    const mode = url.searchParams.get('mode') === 'start' ? 'start' : 'anywhere';
    const fn = mode === 'start' ? core.firstLetterStart : core.firstLetterAnywhere;
    const t = Date.now();
    const found = fn(db, q, { limit });
    const order = new Map(found.map((f, i) => [f.line_id, i]));
    const results = found.length
      ? db.all(`SELECT ${lineCols} FROM lines WHERE line_id IN (${found.map(() => '?').join(',')})`,
               found.map(r => r.line_id)).sort((a, b) => order.get(a.line_id) - order.get(b.line_id))
      : [];
    return {
      query: q, mode, ms: Date.now() - t,
      total: mode === 'anywhere' ? core.firstLetterAnywhereCount(db, q) : results.length,
      results: attachTranslations(results.map(r => ({
        ...r,
        highlight: core.keyboard.highlightWords(r.gurmukhi_ascii, r.first_letters_ascii, q),
      })), parseLangs(url)),
    };
  },

  '/api/shabad': url => {
    const id = parseNonNegativeInt(url.searchParams.get('id'));
    if (id === null) return { error: 'invalid or missing id parameter', code: 400 };
    const lines = db.all(
      `SELECT ${lineCols} FROM lines WHERE shabad_id=? ORDER BY position_in_shabad`, [id]);
    // The rahao is the refrain, sung after every stanza. BaniDB marks only the
    // verse that carries the marker, which is its LAST line; flag the whole
    // stanza so the reader sees the refrain entire.
    const inRahao = core.rahaoStanzaFlags(lines);
    lines.forEach((l, i) => { l.rahao_stanza = inRahao[i]; });
    const meta = db.all('SELECT * FROM shabads WHERE shabad_id=?', [id])[0] || null;
    // agreement comes from the index named (?index=), else the default one
    const agreeFrom = indexes[url.searchParams.get('index')] || indexes[DEFAULT_INDEX];
    return { shabad: meta, darpan: darpanContext(id),
             lines: attachAgreement(attachTranslations(lines, parseLangs(url)), agreeFrom) };
  },

  '/api/similar/line': similar({
    one: (name, entry, id, k, url) => {
      // a source that has no text for this line (a translation that skips it,
      // a heading) has no vector for it either; say so rather than 503
      if (id < entry.art.lines.n && entry.art.lines.mask && entry.art.lines.mask[id] === 0) {
        return { index: name, results: [], note: 'this line has no text in this source' };
      }
      const hits = core.similarLines(entry.art, id, k);
      const rows = linesByIds(hits.map(h => h.id));
      return { index: name, results: attachAgreement(attachTranslations(
        rows.map((r, i) => ({ ...r, score: hits[i].score })), parseLangs(url)), entry) };
    },
    many: (art, id, depth) => (id < art.lines.n && art.lines.mask && art.lines.mask[id] === 0) ? [] : core.similarLines(art, id, depth),
  }, (ids, url) => attachTranslations(linesByIds(ids), parseLangs(url))),

  '/api/similar/shabad': similar({
    one: (name, entry, id, k) => {
      const hits = core.similarShabads(entry.art, id, k);
      const rows = shabadsByIds(hits.map(h => h.id));
      return { index: name, results: rows.map((r, i) => ({ ...r, score: hits[i].score })) };
    },
    many: (art, id, depth) => core.similarShabads(art, id, depth),
  }, ids => shabadsByIds(ids)),

  '/api/similar/rahao': similar({
    one: (name, entry, id, k) => {
      const hits = core.similarByRahao(entry.art, id, k);
      if (!hits.length) return { index: name, results: [], note: 'this shabad has no rahao line' };
      const rows = shabadsByIds(hits.map(h => h.id));
      return { index: name, results: rows.map((r, i) => ({ ...r, score: hits[i].score })) };
    },
    many: (art, id, depth) => core.similarByRahao(art, id, depth),
  }, ids => shabadsByIds(ids)),

  // keymap: physical key -> letter, derived from the same AnmolLipi mapping the
  // index uses (q=ਤ, t=ਟ ...), so typing on a real keyboard matches what
  // BaniDB users already know. Nukta letters fold to their base and so never
  // claim a key a base letter already holds.
  '/api/keyboard': () => ({
    rows: core.keyboard.PAINTI,
    nukta: core.keyboard.NUKTA_ROW,
    matras: core.keyboard.MATRA_ROW,
    keymap: core.keyboard.physicalKeymap(),
    // the same layout named in Roman, for a reader who knows the language but
    // not the script, with the physical keys that mode answers to
    roman: core.keyboard.ROMAN,
    romanKeymap: core.keyboard.ROMAN_KEYMAP,
  }),


  // Free-text search: English against the "en" index, Gurmukhi against "pa".
  // The query is embedded on this machine with the index's own model. Results
  // are Gurmukhi lines; a translation comes back only when ?tr= asks for one.
  '/api/text': async url => {
    const picked = pickIndexes(url, 'text');
    if (picked.error) return picked;
    const q = (url.searchParams.get('q') || '').trim();
    const level = url.searchParams.get('level') === 'shabads' ? 'shabads' : 'lines';
    const k = parseBoundedInt(url.searchParams.get('k'), 1, 50, 15);
    if (picked.all) {
      // every source that has a model and can read this script votes; the
      // fused list is ranked by agreement, not by any one model's cosine
      const able = picked.entries.filter(e => e.encoder && registry.canRead(e.meta, q));
      if (!q) return { index: 'all', results: [] };
      if (!able.length) return { error: 'no loaded index can read this query', code: 503 };
      const t0 = Date.now();
      const vecs = new Map();
      for (const e of able) vecs.set(e.meta.name, core.projectQuery(e.art.pca, await e.encoder.encodeQuery(q)));
      const fused = core.fuseSimilar({ entries: able.map(e => ({ name: e.meta.name, art: e.art, weight: 1 })),
                                       run: (art, depth) => core.searchText(art, vecs.get([...able].find(e => e.art === art).meta.name), level, depth), k });
      const rows = level === 'lines' ? attachTranslations(linesByIds(fused.map(f => f.id)), parseLangs(url)) : shabadsByIds(fused.map(f => f.id));
      const byId = new Map(fused.map(f => [f.id, f]));
      return { index: 'all', indexes: able.map(e => e.meta.name), score_kind: 'rrf', query: q, level, ms: Date.now() - t0,
               results: rows.map(r => ({ ...r, score: byId.get(r.line_id ?? r.shabad_id).score, votes: byId.get(r.line_id ?? r.shabad_id).hits.length })) };
    }
    const name = picked.names[0], entry = picked.entries[0];
    if (!entry.encoder) return { error: `query encoder for index "${name}" not available`, code: 503 };
    if (!q) return { index: name, results: [] };
    // index=all already filters by this; one index by name did not, so a
    // Gurmukhi query against an English index reached a WordPiece tokenizer
    // that renders every letter [UNK] and returned nonsense ranked as results
    if (!registry.canRead(entry.meta, q)) {
      return { error: `index "${name}" cannot read this query's script`, code: 400 };
    }
    const t = Date.now();
    const vec = core.projectQuery(entry.art.pca, await entry.encoder.encodeQuery(q));
    const hits = core.searchText(entry.art, vec, level, k);
    const rows = level === 'lines' ? linesByIds(hits.map(h => h.id)) : shabadsByIds(hits.map(h => h.id));
    const results = rows.map((r, i) => ({ ...r, score: hits[i].score }));
    return { index: name, query: q, level, ms: Date.now() - t,
             results: level === 'lines' ? attachTranslations(results, parseLangs(url)) : results };
  },
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;",
};

const server = http.createServer(async (req, res) => {
  // A CORS preflight is an OPTIONS the method gate below would refuse, so it is
  // answered first. With CORS_ORIGINS unset this does nothing and OPTIONS falls
  // through to the same 405 it always got.
  if (cors.preflight(req, res, SECURITY_HEADERS)) return;
  // Every response carries the cross-origin headers this request earned, which
  // is nothing at all unless CORS_ORIGINS is set.
  const H = { ...SECURITY_HEADERS, ...cors.headers(req) };

  // Method restriction: everything is GET, except a question may be POSTed
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...H, 'allow': 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
    res.end('method not allowed');
    return;
  }

  // Safe host header parsing to prevent uncaught exception DoS
  let url;
  try {
    const host = req.headers.host || '127.0.0.1';
    url = new URL(req.url, `http://${host}`);
  } catch {
    res.writeHead(400, { ...H, 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad request');
    return;
  }


  // Charged before the credential check, so a flood of unauthenticated requests
  // is refused as cheaply as possible. /api/health is never counted.
  const rate = limits.check(url.pathname, req);
  if (rate && rate.code === 429) {
    const { headers: rh, ...body } = rate;
    res.writeHead(429, { ...H, ...rh, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
    return;
  }
  if (rate && rate.headers) Object.assign(H, rate.headers);

  // /api/health stays open so host health checks do not require credentials.
  if (url.pathname !== '/api/health') {
    const ident = await identify(req).catch(() => null);
    if (!ident) {
      res.writeHead(401, {
        ...H,
        // Basic makes a browser show its password box; Bearer must not, or the
        // owner gets a dialog that cannot possibly satisfy it.
        'www-authenticate': identify.challenge(),
        'content-type': 'text/plain; charset=utf-8',
      });
      res.end('credentials required');
      return;
    }
    req.identity = ident;
  }

  const handler = routes[url.pathname];
  if (handler) {
    Promise.resolve()
      .then(() => handler(url, req))
      .catch(err => {
        console.error(`Error handling ${url.pathname}:`, err);
        return { error: IS_PROD ? 'Internal Server Error' : err.message, code: 500 };
      })
      .then(body => {
        const code = body && body.code ? body.code : 200;
        res.writeHead(code, {
          ...H,
          'content-type': 'application/json; charset=utf-8',
        });
        res.end(JSON.stringify(body));
      });
    return;
  }

  // Static file serving with strict path traversal prevention
  let decodedRel;
  try {
    decodedRel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { ...H, 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad request');
    return;
  }
  if (decodedRel.includes('\0')) {
    res.writeHead(400, { ...H, 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad request');
    return;
  }
  const rel = decodedRel === '/' ? 'index.html' : decodedRel.replace(/^[\/\\]+/, '');
  const file = path.resolve(PUBLIC_DIR, '.' + path.sep + rel);

  // Assert resolved path is within PUBLIC_DIR
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) {
    res.writeHead(403, { ...H, 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { ...H, 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      ...H,
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    });
    res.end(data);
  });
});

function shutdown() {
  console.log('\nShutting down server gracefully...');
  server.close(() => {
    try { db.close(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

(async () => {
  for (const d of registry.discoverIndexDirs(ARTIFACTS)) {
    if (d.warning) console.warn(`index "${d.name}": ${d.warning}`);
    if (!d.manifest) continue;
    const meta = registry.normalizeManifest(d.manifest);
    if (!meta.roles.length) { console.log(`index "${d.name}": lab candidate, not loaded`); continue; }
    if (ONLY.length && !ONLY.includes(d.name)) { console.log(`index "${d.name}": not in INDEXES, skipped`); continue; }
    known.add(d.name);
    const entry = await tryLoadIndex(d.name, d.dir);
    if (!entry) continue;
    entry.meta = meta;
    // an index that only serves neighbours never needs its model in memory
    entry.encoder = meta.roles.includes('text') || meta.roles.includes('ask') ? await tryLoadEncoder(d.name, entry) : null;
    indexes[d.name] = entry;
  }
  if (!indexes[DEFAULT_INDEX]) {
    const first = registry.orderIndexes(indexes)[0] || null;
    if (first) {
      console.warn(`default index "${DEFAULT_INDEX}" is not loaded; using "${first}"`);
      DEFAULT_INDEX = first;
    }
  }
  if (fs.existsSync(TRANSLATIONS_PATH)) {
    try {
      tdb = core.openNodeAdapter(TRANSLATIONS_PATH);
      const langs = Object.entries(availableLangs()).filter(([, on]) => on).map(([l]) => l);
      console.log(`translations: ${langs.join(' ') || 'none'}`);
    } catch (err) {
      console.warn('translations unavailable:', err.message);
      tdb = null;
    }
  }
  const state = [...new Set([...known, ...Object.keys(indexes)])].sort()
    .map(n => `${n}:${indexes[n] ? (indexes[n].encoder ? 'on+text' : 'on') : 'off'}`).join(' ');
  server.listen(PORT, () => console.log(
    `http://localhost:${PORT}  (indexes ${state}, password: ${APP_PASSWORD ? 'on' : 'off'})  `
    + `db: ${path.relative(ROOT, DB_PATH)}`));
})();
