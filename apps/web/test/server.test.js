'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

test('server static path traversal protection', () => {
  const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

  const checkPath = urlPath => {
    let decodedRel;
    try {
      decodedRel = decodeURIComponent(urlPath);
    } catch {
      return 'bad_request';
    }
    if (decodedRel.includes('\0')) return 'bad_request';
    const rel = decodedRel === '/' ? 'index.html' : decodedRel.replace(/^[\/\\]+/, '');
    const file = path.resolve(PUBLIC_DIR, '.' + path.sep + rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) {
      return 'forbidden';
    }
    return 'allowed';
  };

  assert.strictEqual(checkPath('/index.html'), 'allowed');
  assert.strictEqual(checkPath('/'), 'allowed');
  assert.strictEqual(checkPath('/../../package.json'), 'forbidden');
  assert.strictEqual(checkPath('/..\\..\\package.json'), 'forbidden');
  assert.strictEqual(checkPath('/..%2f..%2fpackage.json'), 'forbidden');
  assert.strictEqual(checkPath('/..%5c..%5cpackage.json'), 'forbidden');
  assert.strictEqual(checkPath('/test%00.html'), 'bad_request');
});
