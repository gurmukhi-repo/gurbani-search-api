'use strict';
/**
 * Cross-origin access. The unit half runs everywhere; the HTTP half needs the
 * database and spawns a real server, because the interesting assertions are
 * about what a preflight and a 405 look like on the wire.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createCors, normalize } = require('../cors.js');

const quiet = { warn() {}, log() {} };
const req = (origin, method = 'GET', extra = {}) =>
  ({ method, headers: { ...(origin ? { origin } : {}), ...extra } });

/** Captures one writeHead/end pair. */
const recorder = () => {
  const r = { code: null, headers: null, body: '' };
  return Object.assign(r, {
    writeHead(code, headers) { r.code = code; r.headers = headers; },
    end(b) { r.body = b || ''; },
  });
};

test('unset means no CORS at all -- not even a Vary', () => {
  const c = createCors({}, quiet);
  assert.strictEqual(c.enabled, false);
  assert.deepStrictEqual(c.headers(req('https://example.com')), {});
  assert.deepStrictEqual(c.summary(), { enabled: false });
  // and a preflight is not intercepted, so it falls through to the 405
  assert.strictEqual(c.preflight(req('https://example.com', 'OPTIONS'), recorder()), false);
});

test('an allowlisted origin is echoed and may send credentials', () => {
  const c = createCors({ CORS_ORIGINS: 'https://a.example,https://b.example:8443' }, quiet);
  assert.strictEqual(c.credentials, true);
  const h = c.headers(req('https://b.example:8443'));
  assert.strictEqual(h['access-control-allow-origin'], 'https://b.example:8443');
  assert.strictEqual(h['access-control-allow-credentials'], 'true');
  assert.strictEqual(h.vary, 'Origin');
});

test('an origin that is not on the list gets no allowance', () => {
  const c = createCors({ CORS_ORIGINS: 'https://a.example' }, quiet);
  for (const o of ['https://evil.example', 'http://a.example', 'https://a.example:8443',
                   'https://a.example.evil.com', 'https://sub.a.example']) {
    const h = c.headers(req(o));
    assert.strictEqual(h['access-control-allow-origin'], undefined, o);
    // Vary still goes out: the answer DID depend on the origin, and a cache that
    // does not know that will hand this refusal to someone who was allowed.
    assert.strictEqual(h.vary, 'Origin', o);
  }
});

test('scheme and port are part of the origin, so matching is exact', () => {
  assert.strictEqual(normalize('https://a.example/some/path'), 'https://a.example');
  assert.strictEqual(normalize('https://a.example/'), 'https://a.example');
  assert.strictEqual(normalize('not a url'), null);
  // a trailing slash or a path in the env var must not stop the origin matching
  const c = createCors({ CORS_ORIGINS: 'https://a.example/' }, quiet);
  assert.strictEqual(c.headers(req('https://a.example'))['access-control-allow-origin'], 'https://a.example');
});

test('* allows any origin but NEVER credentials', () => {
  const c = createCors({ CORS_ORIGINS: '*' }, quiet);
  assert.strictEqual(c.credentials, false);
  const h = c.headers(req('https://anyone.example'));
  assert.strictEqual(h['access-control-allow-origin'], '*');
  assert.strictEqual(h['access-control-allow-credentials'], undefined,
    '"*" with credentials would let any page read a password-protected deployment');
});

test('* with a password warns, because the combination surprises people', () => {
  const warnings = [];
  createCors({ CORS_ORIGINS: '*', APP_PASSWORD: 'p' }, { warn: m => warnings.push(m) });
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /APP_PASSWORD/);
});

test('a malformed origin in the env var is dropped with a warning, not a crash', () => {
  const warnings = [];
  const c = createCors({ CORS_ORIGINS: 'https://good.example, nonsense, ' },
                       { warn: m => warnings.push(m) });
  assert.deepStrictEqual(c.origins, ['https://good.example']);
  assert.strictEqual(warnings.length, 1);
});

test('a request with no Origin header gets no CORS headers', () => {
  const c = createCors({ CORS_ORIGINS: '*' }, quiet);
  assert.deepStrictEqual(c.headers(req(null)), { vary: 'Origin' });
  // and a bare OPTIONS is not a preflight
  assert.strictEqual(c.preflight(req(null, 'OPTIONS'), recorder()), false);
});

test('a preflight is answered 204 with the methods and the asked-for headers', () => {
  const c = createCors({ CORS_ORIGINS: 'https://a.example' }, quiet);
  const res = recorder();
  const handled = c.preflight(
    req('https://a.example', 'OPTIONS', { 'access-control-request-headers': 'authorization,x-thing' }),
    res, { 'x-base': '1' });
  assert.strictEqual(handled, true);
  assert.strictEqual(res.code, 204);
  assert.strictEqual(res.headers['x-base'], '1', 'the security headers still go out');
  assert.strictEqual(res.headers['access-control-allow-origin'], 'https://a.example');
  assert.strictEqual(res.headers['access-control-allow-methods'], 'GET, HEAD, OPTIONS');
  assert.strictEqual(res.headers['access-control-allow-headers'], 'authorization,x-thing');
  assert.ok(Number(res.headers['access-control-max-age']) > 0);
  assert.strictEqual(res.body, '');
});

test('a preflight from a refused origin is 403, so the developer can tell why', () => {
  const c = createCors({ CORS_ORIGINS: 'https://a.example' }, quiet);
  const res = recorder();
  assert.strictEqual(c.preflight(req('https://evil.example', 'OPTIONS'), res), true);
  assert.strictEqual(res.code, 403);
  assert.strictEqual(res.headers['access-control-allow-origin'], undefined);
});

// --- over HTTP ---------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ARTIFACTS = process.env.ARTIFACTS_DIR || path.join(ROOT, 'artifacts');
const HAS_DB = fs.existsSync(path.join(ARTIFACTS, 'gurbani.sqlite'));
const PORT = 5203;
const BASE = `http://127.0.0.1:${PORT}`;
let child = null;

test.before(async () => {
  if (!HAS_DB) return;
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), APP_PASSWORD: '',
           CORS_ORIGINS: 'https://reader.example' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 120000);
    child.stdout.on('data', d => { if (String(d).includes('http://localhost')) { clearTimeout(timer); resolve(); } });
    child.on('exit', c => reject(new Error(`server exited with ${c}`)));
  });
});
test.after(async () => {
  if (!child) return;
  const done = new Promise(r => child.on('exit', r));
  child.kill();
  await done;
});

test('the allowed origin gets its headers on a real response', { skip: !HAS_DB }, async () => {
  const res = await fetch(BASE + '/api/fl?q=gnm&limit=1', { headers: { origin: 'https://reader.example' } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('access-control-allow-origin'), 'https://reader.example');
  assert.strictEqual(res.headers.get('access-control-allow-credentials'), 'true');
  assert.strictEqual(res.headers.get('vary'), 'Origin');
  // the security headers are not lost in the merge
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
});

test('another origin is refused, and health reports the configuration', { skip: !HAS_DB }, async () => {
  const res = await fetch(BASE + '/api/fl?q=gnm&limit=1', { headers: { origin: 'https://evil.example' } });
  assert.strictEqual(res.status, 200, 'the API still answers; the BROWSER is what blocks it');
  assert.strictEqual(res.headers.get('access-control-allow-origin'), null);

  const health = await (await fetch(BASE + '/api/health')).json();
  assert.deepStrictEqual(health.cors,
    { enabled: true, origins: ['https://reader.example'], credentials: true });
});

test('preflight over HTTP is a 204, and /api/health preflights too', { skip: !HAS_DB }, async () => {
  for (const p of ['/api/text?q=x', '/api/health']) {
    const res = await fetch(BASE + p, {
      method: 'OPTIONS',
      headers: { origin: 'https://reader.example', 'access-control-request-method': 'GET' },
    });
    assert.strictEqual(res.status, 204, p);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), 'https://reader.example', p);
  }
});

test('a non-preflight OPTIONS is still a 405', { skip: !HAS_DB }, async () => {
  const res = await fetch(BASE + '/api/health', { method: 'OPTIONS' });   // no Origin
  assert.strictEqual(res.status, 405);
});
