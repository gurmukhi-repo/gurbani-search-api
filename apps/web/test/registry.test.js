'use strict';
/**
 * The index registry: what an old manifest is taken to mean, what a query
 * needs from an index, and how directories become indexes.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeManifest, discoverIndexDirs, canRead, orderIndexes, summarize } = require('../registry.js');

test('an old English manifest gets the defaults the app used to hard-code', () => {
  const m = normalizeManifest({ index: 'en', text_source: 'translations', enriched: false, model: 'bge' });
  assert.strictEqual(m.text_source, 'ssk,bdb,ms');
  assert.strictEqual(m.text_lang, 'en');
  assert.deepStrictEqual(m.query_scripts, ['latin']);
  assert.deepStrictEqual(m.roles, ['neighbours', 'text', 'ask']);
  assert.strictEqual(m.ask_weight, 1);
  assert.strictEqual(m.order, 100);
  assert.strictEqual(m.label, 'en');
  assert.strictEqual(m.enriched, 'none');
  assert.deepStrictEqual(m.source.translators, ['ssk', 'bdb', 'ms']);
});

test('an old Gurmukhi manifest reads both scripts; `enriched: true` means Mahan Kosh', () => {
  const m = normalizeManifest({ index: 'pa', text_source: 'gurmukhi_uni', enriched: true });
  assert.strictEqual(m.text_lang, 'pa');
  assert.deepStrictEqual(m.query_scripts, ['gurmukhi', 'latin']);
  assert.strictEqual(m.enriched, 'kosh');
});

test('explicit fields win, and unknown roles are dropped', () => {
  const m = normalizeManifest({ index: 'ss-en', text_source: 'en-ss-mt', text_lang: 'en', label: 'Darpan · English',
    query_scripts: ['latin'], roles: ['neighbours', 'text', 'nonsense'], ask_weight: 0.5, order: 20, enriched: 'pss' });
  assert.strictEqual(m.label, 'Darpan · English');
  assert.deepStrictEqual(m.roles, ['neighbours', 'text']);
  assert.strictEqual(m.ask_weight, 0.5);
  assert.strictEqual(m.order, 20);
  assert.strictEqual(m.enriched, 'pss');
  assert.deepStrictEqual(normalizeManifest({ index: 'x', roles: [] }).roles, [], 'roles [] is a lab index, kept as []');
});

test('canRead: Gurmukhi text needs an index whose model reads Gurmukhi', () => {
  const en = normalizeManifest({ index: 'en', text_source: 'translations' });
  const pa = normalizeManifest({ index: 'pa', text_source: 'gurmukhi_uni' });
  assert.ok(canRead(en, 'the fear of death'));
  assert.ok(!canRead(en, 'ਮੌਤ ਦਾ ਡਰ'));
  assert.ok(canRead(pa, 'ਮੌਤ ਦਾ ਡਰ'));
  assert.ok(canRead(pa, 'fear'), 'the multilingual model reads Latin script too');
});

test('orderIndexes sorts by order, then name; summarize carries the presentation fields', () => {
  const entries = {
    b: { meta: normalizeManifest({ index: 'b', order: 20 }), encoder: null },
    a: { meta: normalizeManifest({ index: 'a', order: 20 }), encoder: {} },
    z: { meta: normalizeManifest({ index: 'z', order: 5 }), encoder: null },
  };
  assert.deepStrictEqual(orderIndexes(entries), ['z', 'a', 'b']);
  const row = summarize(entries.a);
  assert.strictEqual(row.loaded, true);
  assert.strictEqual(row.freeText, true);
  for (const k of ['label', 'text_lang', 'query_scripts', 'roles', 'ask_weight', 'order', 'text_source']) assert.ok(k in row, k);
});

test('discoverIndexDirs: the root manifest, every subdirectory with one, keyed by the manifest name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gurbani-registry-'));
  const put = (sub, manifest) => {
    const d = sub ? path.join(dir, sub) : dir;
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(manifest));
  };
  put(null, { index: 'en', text_source: 'translations' });
  put('pa', { index: 'pa', text_source: 'gurmukhi_uni' });
  put('lab', { index: 'lab', text_source: 'gurmukhi_uni', roles: [] });
  put('copy', { index: 'en', text_source: 'translations' });     // a copied manifest claiming the root's name
  fs.mkdirSync(path.join(dir, 'empty'));
  fs.mkdirSync(path.join(dir, 'broken'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'broken', 'manifest.json'), '{not json');
  const found = discoverIndexDirs(dir);
  const byName = Object.fromEntries(found.filter(f => f.manifest).map(f => [f.name, f]));
  assert.deepStrictEqual(Object.keys(byName).sort(), ['en', 'lab', 'pa']);
  assert.strictEqual(byName.en.dir, dir, 'the root wins the name en');
  assert.ok(found.some(f => f.warning && /duplicate index "en"/.test(f.warning)), 'the copy is reported, not loaded');
  assert.ok(found.some(f => f.warning && /unreadable/.test(f.warning)), 'a broken manifest is reported');
  assert.ok(!found.some(f => f.dir.endsWith('empty')), 'a directory without a manifest is not an index');
  assert.deepStrictEqual(normalizeManifest(byName.lab.manifest).roles, []);
  fs.rmSync(dir, { recursive: true, force: true });
});
