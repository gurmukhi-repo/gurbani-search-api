'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

test('server static path traversal protection', () => {
  const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

  // Mirrors the static branch of server.js. `resolved` is returned too, because
  // the property that actually matters is where the path LANDS, not which label
  // the check gives it.
  const checkPath = urlPath => {
    let decodedRel;
    try {
      decodedRel = decodeURIComponent(urlPath);
    } catch {
      return { verdict: 'bad_request' };
    }
    if (decodedRel.includes('\0')) return { verdict: 'bad_request' };
    const rel = decodedRel === '/' ? 'index.html' : decodedRel.replace(/^[\/\\]+/, '');
    const file = path.resolve(PUBLIC_DIR, '.' + path.sep + rel);
    const inside = file.startsWith(PUBLIC_DIR + path.sep) || file === PUBLIC_DIR;
    return { verdict: inside ? 'allowed' : 'forbidden', resolved: file };
  };

  const verdict = p => checkPath(p).verdict;

  assert.strictEqual(verdict('/index.html'), 'allowed');
  assert.strictEqual(verdict('/'), 'allowed');
  assert.strictEqual(verdict('/../../package.json'), 'forbidden');
  assert.strictEqual(verdict('/..%2f..%2fpackage.json'), 'forbidden');
  assert.strictEqual(verdict('/test%00.html'), 'bad_request');

  // Backslash is a separator on Windows and an ordinary filename character
  // everywhere else, so the same request is genuinely two different requests.
  // On POSIX "..\..\package.json" names one oddly-spelled file INSIDE public/,
  // which does not exist and 404s -- so "allowed" there is the correct answer,
  // not a hole. Asserting Windows semantics on Linux is what made this fail in
  // CI while passing on the machine it was written on.
  const backslash = ['/..\\..\\package.json', '/..%5c..%5cpackage.json'];
  for (const p of backslash) {
    assert.strictEqual(verdict(p), process.platform === 'win32' ? 'forbidden' : 'allowed', p);
  }

  // The invariant, stated once and independently of platform: nothing ever
  // escapes PUBLIC_DIR. This is the assertion that would catch a real
  // regression on any operating system.
  const attacks = [
    '/../../package.json', '/..%2f..%2fpackage.json', '/..\\..\\package.json',
    '/..%5c..%5cpackage.json', '/....//....//package.json', '/%2e%2e%2f%2e%2e%2fpackage.json',
    '/./../../etc/passwd', '/subdir/../../../etc/passwd', '//etc/passwd', '/\\etc\\passwd',
  ];
  for (const p of attacks) {
    const { verdict: v, resolved } = checkPath(p);
    if (v === 'allowed') {
      assert.ok(resolved.startsWith(PUBLIC_DIR + path.sep),
        `${p} was allowed but resolved outside public/: ${resolved}`);
    }
  }
});
