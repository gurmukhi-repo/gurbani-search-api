'use strict';
/**
 * Access logging. The assertion that matters most is the one about what is NOT
 * written down.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createLogger, safeQuery } = require('../logging.js');
const { desiredWorkers } = require('../cluster.js');

const capture = () => {
  const lines = [];
  const warns = [];
  return { lines, warns, log: m => lines.push(m), warn: m => warns.push(m) };
};
const req = url => ({ method: 'GET', url, client: '198.51.100.9' });

test('unset writes nothing', () => {
  const out = capture();
  const log = createLogger({}, out);
  assert.strictEqual(log.enabled, false);
  log(req('/api/fl?q=gnm'), 200, 3, 100);
  assert.deepStrictEqual(out.lines, []);
  assert.deepStrictEqual(log.summary(), { enabled: false });
});

test('an unrecognised value is off, not a crash and not a default', () => {
  for (const v of ['yes', '1', 'true', 'verbose']) {
    assert.strictEqual(createLogger({ LOG_REQUESTS: v }, capture()).enabled, false, v);
  }
});

test('the search term is not written down by default', () => {
  const out = capture();
  const log = createLogger({ LOG_REQUESTS: 'json' }, out);
  log(req('/api/text?q=how%20do%20I%20cope%20with%20my%20grief&k=5&index=all'), 200, 40, 900);
  const line = JSON.parse(out.lines[0]);
  // What someone asked Gurbani about is a private religious enquiry, and pairing
  // it with an address and a timestamp is a record of it. Operators opt in.
  assert.ok(!out.lines[0].includes('grief'), out.lines[0]);
  assert.strictEqual(line.path, '/api/text');
  assert.match(line.query, /k=5/);
  assert.match(line.query, /index=all/);
  assert.ok(!line.query.includes('q='), 'q must be gone entirely, not blanked');
});

test('LOG_QUERIES=1 includes it, and says so at startup', () => {
  const out = capture();
  const log = createLogger({ LOG_REQUESTS: 'json', LOG_QUERIES: '1' }, out);
  assert.strictEqual(out.warns.length, 1);
  assert.match(out.warns[0], /search terms/);
  log(req('/api/text?q=grief'), 200, 40, 900);
  assert.match(out.lines[0], /grief/);
});

test('json mode is one parseable object per line with the fields an aggregator needs', () => {
  const out = capture();
  createLogger({ LOG_REQUESTS: 'json' }, out)(req('/api/fl?limit=5'), 429, 2, 88);
  const o = JSON.parse(out.lines[0]);
  assert.strictEqual(o.method, 'GET');
  assert.strictEqual(o.path, '/api/fl');
  assert.strictEqual(o.status, 429);
  assert.strictEqual(o.ms, 2);
  assert.strictEqual(o.bytes, 88);
  assert.strictEqual(o.client, '198.51.100.9');
  assert.ok(!Number.isNaN(Date.parse(o.t)), 'timestamp parses');
});

test('text mode is one line and mentions the essentials', () => {
  const out = capture();
  createLogger({ LOG_REQUESTS: 'text' }, out)(req('/api/shabad?id=81'), 200, 5, 1000);
  assert.strictEqual(out.lines.length, 1);
  for (const part of ['198.51.100.9', 'GET', '/api/shabad', '200', '5ms']) {
    assert.ok(out.lines[0].includes(part), `${part} missing from: ${out.lines[0]}`);
  }
});

test('a request with no query string does not produce a stray question mark', () => {
  assert.strictEqual(safeQuery('', false), '');
  assert.strictEqual(safeQuery('q=x', false), '', 'dropping the only parameter leaves nothing');
  assert.strictEqual(safeQuery('q=x&k=2', false), '?k=2');
});

// --- cluster -----------------------------------------------------------------

test('CLUSTER_WORKERS defaults to one process', () => {
  assert.strictEqual(desiredWorkers({}), 1);
  assert.strictEqual(desiredWorkers({ CLUSTER_WORKERS: '' }), 1);
  assert.strictEqual(desiredWorkers({ CLUSTER_WORKERS: '1' }), 1);
});

test('a nonsense worker count falls back to one rather than to zero or NaN', () => {
  for (const v of ['banana', '0', '-4', '0.5']) {
    assert.strictEqual(desiredWorkers({ CLUSTER_WORKERS: v }), 1, v);
  }
});

test('auto is the machine parallelism, and a number is that number', () => {
  assert.ok(desiredWorkers({ CLUSTER_WORKERS: 'auto' }) >= 1);
  assert.strictEqual(desiredWorkers({ CLUSTER_WORKERS: '3' }), 3);
  assert.strictEqual(desiredWorkers({ CLUSTER_WORKERS: 'AUTO' }), desiredWorkers({ CLUSTER_WORKERS: 'auto' }));
});
