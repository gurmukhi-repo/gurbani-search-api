'use strict';
/**
 * The Basic-auth gate. This is the only security-sensitive code in this
 * repository that is not shared with the project it was extracted from, so it
 * gets its own tests.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createIdentifier, checkBasic } = require('../accounts/identity.js');

const basic = (user, pass) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
const req = authorization => ({ headers: authorization ? { authorization } : {} });

test('with no password configured the server is open', async () => {
  const identify = createIdentifier({});
  assert.deepStrictEqual(await identify(req()), { kind: 'owner', id: 'owner' });
  assert.strictEqual(identify.enabled, false);
  assert.strictEqual(identify.accounts, false);
});

test('with a password, the right one is admitted and everything else is not', async () => {
  const identify = createIdentifier({ APP_PASSWORD: 'let me in' });
  assert.deepStrictEqual(await identify(req(basic('reader', 'let me in'))), { kind: 'owner', id: 'owner' });
  assert.strictEqual(await identify(req()), null, 'no header');
  assert.strictEqual(await identify(req(basic('reader', 'wrong'))), null, 'wrong password');
  assert.strictEqual(await identify(req('Bearer something')), null, 'there is no token scheme here');
  assert.strictEqual(await identify(req('Basic !!!not base64!!!')), null, 'malformed');
  assert.strictEqual(identify.enabled, true);
});

test('the username is ignored; only the password decides', async () => {
  const identify = createIdentifier({ APP_PASSWORD: 'p' });
  for (const user of ['', 'anyone', 'admin']) {
    assert.deepStrictEqual(await identify(req(basic(user, 'p'))), { kind: 'owner', id: 'owner' }, user);
  }
});

test('a password containing a colon survives the split', async () => {
  // the first colon separates user from password; the rest belong to the password
  const identify = createIdentifier({ APP_PASSWORD: 'a:b:c' });
  assert.deepStrictEqual(await identify(req(basic('u', 'a:b:c'))), { kind: 'owner', id: 'owner' });
});

test('checkBasic does not throw on garbage, it returns false', () => {
  for (const h of ['', 'Basic', 'Basic ', 'Bearer x', 'Basic ' + 'z'.repeat(1000)]) {
    assert.strictEqual(checkBasic(h, 'p'), false, JSON.stringify(h));
  }
});

test('the challenge names Basic, so a browser offers a password box', () => {
  assert.match(createIdentifier({ APP_PASSWORD: 'p' }).challenge(), /^Basic realm=/);
});
