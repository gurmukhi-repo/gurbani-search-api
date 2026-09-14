'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { gurmukhi, keyboard } = require('../src/index-node.js');
const { isPunctuation, WordPieceTokenizer } = require('../../query-encoder/src/tokenizer.js');

test('bindiVariant replaces tokens without substring corruption', () => {
  // 115 is 's' (ਸ) -> 083 ('S' ਸ਼)
  const q = ',115,110,115';
  const variant = gurmukhi.bindiVariant(q);
  assert.strictEqual(variant, ',083,110,083');

  // Query with no bindi characters returns null
  assert.strictEqual(gurmukhi.bindiVariant(',110,113'), null);
});

test('isPunctuation matches HuggingFace: ASCII ranges plus Unicode category P, not symbols', () => {
  // ASCII punctuation
  assert.strictEqual(isPunctuation('!'), true);
  assert.strictEqual(isPunctuation('.'), true);
  // Alphanumeric characters
  assert.strictEqual(isPunctuation('a'), false);
  assert.strictEqual(isPunctuation('1'), false);
  // ASCII symbols are punctuation by the explicit code-point ranges ...
  assert.strictEqual(isPunctuation('$'), true);
  // ... but non-ASCII symbols (category S) are not, exactly as in Python.
  assert.strictEqual(isPunctuation('€'), false);
  assert.strictEqual(isPunctuation('©'), false);
  assert.strictEqual(isPunctuation('।'), true);
});

test('matchSpan highlights words when bindi variants match', () => {
  // Line has 'S' (ਸ਼), user types 's' (ਸ)
  const lineAsciiFirstLetters = 'knSjq';
  const span = keyboard.matchSpan(lineAsciiFirstLetters, 'ਸਜ');
  assert.ok(span !== null, 'must find match despite bindi difference');
  assert.strictEqual(span.start, 2);
  assert.strictEqual(span.length, 2);
});

test('empty batch does not throw in WordPieceTokenizer', () => {
  const dummyVocab = { '[PAD]': 0, '[UNK]': 100, '[CLS]': 101, '[SEP]': 102 };
  const tok = new WordPieceTokenizer({ model: { vocab: dummyVocab } });
  const res = tok.encodeBatch([]);
  assert.deepStrictEqual(res, []);
});
