'use strict';
/**
 * Rahao stanza detection -- what the reader sees set in bold.
 *
 * The claim under test is narrow but easy to get wrong: the rahao is a STANZA,
 * and BaniDB marks only its last line. Flagging the marked line alone (what the
 * app did before) bolds half a couplet.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { isStanzaEnd, rahaoStanzaFlags } = require('../src/stanza.js');

test('a stanza ends at its counter, and nothing else does', () => {
  assert.ok(isStanzaEnd('ਹੁਕਮਿ ਰਜਾਈ ਚਲਣਾ ਨਾਨਕ ਲਿਖਿਆ ਨਾਲਿ ॥੧॥'));
  assert.ok(isStanzaEnd('ਤੇਰਾ ਅੰਤੁ ਨ ਪਾਰਾਵਰਿਆ ॥੪॥੫॥'), 'stanza and running count');
  assert.ok(isStanzaEnd('ਨਾਨਕ ਹਰਿ ਨਾਮਿ ਸਮਾਇ ॥੪॥੬॥੩੯॥'), 'three counters');
  assert.ok(!isStanzaEnd('ਮੇਰੇ ਮਾਧਉ ਜੀ ਸਤਸੰਗਤਿ ਮਿਲੇ ਸੁ ਤਰਿਆ ॥'), 'a plain line');
  // the rahao's own line carries a counter but is followed by the marker, so it
  // never closes a stanza -- it closes the refrain
  assert.ok(!isStanzaEnd('ਸੂਕੇ ਕਾਸਟ ਹਰਿਆ ॥੧॥ ਰਹਾਉ ॥'));
});

test('the whole rahao stanza is flagged, not only the marked line', () => {
  // ang 10, Gujri M5: heading, two lines closed by ॥੧॥, then the refrain
  const lines = [
    { kind: 'heading', gurmukhi_uni: 'ਰਾਗੁ ਗੂਜਰੀ ਮਹਲਾ ੫ ॥' },
    { kind: 'line', gurmukhi_uni: 'ਕਾਹੇ ਰੇ ਮਨ ਚਿਤਵਹਿ ਉਦਮੁ ਜਾ ਆਹਰਿ ਹਰਿ ਜੀਉ ਪਰਿਆ ॥' },
    { kind: 'line', gurmukhi_uni: 'ਸੈਲ ਪਥਰ ਮਹਿ ਜੰਤ ਉਪਾਏ ਤਾ ਕਾ ਰਿਜਕੁ ਆਗੈ ਕਰਿ ਧਰਿਆ ॥੧॥' },
    { kind: 'line', gurmukhi_uni: 'ਮੇਰੇ ਮਾਧਉ ਜੀ ਸਤਸੰਗਤਿ ਮਿਲੇ ਸੁ ਤਰਿਆ ॥' },
    { kind: 'rahao', gurmukhi_uni: 'ਗੁਰ ਪਰਸਾਦਿ ਪਰਮ ਪਦੁ ਪਾਇਆ ਸੂਕੇ ਕਾਸਟ ਹਰਿਆ ॥੧॥ ਰਹਾਉ ॥' },
    { kind: 'line', gurmukhi_uni: 'ਜਨਨਿ ਪਿਤਾ ਲੋਕ ਸੁਤ ਬਨਿਤਾ ਕੋਇ ਨ ਕਿਸ ਕੀ ਧਰਿਆ ॥' },
  ];
  assert.deepStrictEqual(rahaoStanzaFlags(lines), [false, false, false, true, true, false]);
});

test('a shabad opening on its rahao does not swallow the heading', () => {
  const lines = [
    { kind: 'heading', gurmukhi_uni: 'ਆਸਾ ਮਹਲਾ ੧ ॥' },
    { kind: 'rahao', gurmukhi_uni: 'ਸੁਣਿ ਮਨ ਭੂਲੇ ਬਾਵਰੇ ॥੧॥ ਰਹਾਉ ॥' },
  ];
  assert.deepStrictEqual(rahaoStanzaFlags(lines), [false, true]);
});

test('two rahaos in one shabad stay two stanzas', () => {
  const lines = [
    { kind: 'line', gurmukhi_uni: 'ਪਹਿਲੀ ਪੰਕਤੀ ॥' },
    { kind: 'rahao', gurmukhi_uni: 'ਪਹਿਲਾ ਰਹਾਉ ॥੧॥ ਰਹਾਉ ॥' },
    { kind: 'line', gurmukhi_uni: 'ਅੰਤਰਾ ਮੁੱਕਦਾ ॥੧॥' },
    { kind: 'line', gurmukhi_uni: 'ਦੂਜੀ ਪੰਕਤੀ ॥' },
    { kind: 'rahao', gurmukhi_uni: 'ਦੂਜਾ ਰਹਾਉ ॥੨॥ ਰਹਾਉ ਦੂਜਾ ॥' },
  ];
  // the second refrain reaches back only to the counter, never across it
  assert.deepStrictEqual(rahaoStanzaFlags(lines), [true, true, false, true, true]);
});

test('over the whole corpus every rahao sits in a stanza of a plausible size', () => {
  const CORPUS = process.env.CORPUS_DB || path.resolve(__dirname, '..', '..', '..', 'data', 'corpus.sqlite');
  if (!fs.existsSync(CORPUS)) return;
  const { openNodeAdapter } = require('../src/index-node.js');
  const db = openNodeAdapter(CORPUS);
  const rows = db.all(
    'SELECT shabad_id, position_in_shabad, kind, gurmukhi_uni FROM lines ORDER BY shabad_id, position_in_shabad', []);
  const byShabad = new Map();
  for (const r of rows) {
    if (!byShabad.has(r.shabad_id)) byShabad.set(r.shabad_id, []);
    byShabad.get(r.shabad_id).push(r);
  }
  let rahaoLines = 0, flaggedRahao = 0, stanzas = 0, twoLine = 0, longest = 0;
  for (const lines of byShabad.values()) {
    const flags = rahaoStanzaFlags(lines);
    lines.forEach((l, i) => {
      if (l.kind !== 'rahao') return;
      rahaoLines += 1;
      if (flags[i]) flaggedRahao += 1;
    });
    for (let i = 0; i < flags.length;) {
      if (!flags[i]) { i += 1; continue; }
      let j = i;
      while (j < flags.length && flags[j]) j += 1;
      stanzas += 1;
      if (j - i === 2) twoLine += 1;
      longest = Math.max(longest, j - i);
      i = j;
    }
  }
  db.close();
  assert.strictEqual(rahaoLines, 2679, 'every rahao line in SGGS');
  assert.strictEqual(flaggedRahao, rahaoLines, 'no rahao line is left unflagged');
  assert.strictEqual(stanzas, rahaoLines, 'one stanza per rahao line');
  // a refrain is a couplet in the overwhelming majority; if that ever collapses
  // to "one line each", the walk back has stopped working
  assert.ok(twoLine / stanzas > 0.9, `two-line refrains: ${twoLine}/${stanzas}`);
  assert.ok(longest <= 8, `longest refrain ${longest} lines`);
});
