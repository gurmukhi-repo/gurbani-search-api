#!/usr/bin/env node
'use strict';
/**
 * What can this machine run, and what would it take to run more?
 *
 * Exists so that "why are 60 tests skipped?" never becomes a question anyone has
 * to ask. Most of this project's tests need data that is not in the repository,
 * and they skip themselves cleanly when it is absent -- which is correct, and
 * looks broken if nobody tells you.
 *
 * Always exits 0: this reports, it does not gate.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.GURBANI_DATA_DIR || path.join(ROOT, 'data');
const ARTIFACTS = process.env.ARTIFACTS_DIR || path.join(DATA, 'artifacts');
const MODELS = process.env.MODELS_DIR || path.join(DATA, 'models');

const yes = '  yes';
const no = '  no ';
const exists = p => fs.existsSync(p);
const mb = n => (n / 1048576).toFixed(1) + 'MB';

function dirSize(d) {
  let n = 0;
  const walk = p => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) walk(f); else n += fs.statSync(f).size;
    }
  };
  try { walk(d); } catch { /* absent */ }
  return n;
}

const major = Number(process.versions.node.split('.')[0]);
console.log(`\nnode          ${process.version} ${major >= 22 ? '' : '  <-- too old; this needs 22+ for node:sqlite'}`);
console.log(`platform      ${process.platform} ${process.arch}`);

const db = exists(path.join(ARTIFACTS, 'gurbani.sqlite'));
const translations = exists(path.join(ARTIFACTS, 'translations.sqlite'));
const indexes = exists(ARTIFACTS)
  ? fs.readdirSync(ARTIFACTS, { withFileTypes: true })
      .filter(e => e.isDirectory() && exists(path.join(ARTIFACTS, e.name, 'manifest.json')))
      .map(e => e.name)
  : [];
const models = exists(MODELS)
  ? fs.readdirSync(MODELS, { withFileTypes: true })
      .filter(e => e.isDirectory() && exists(path.join(MODELS, e.name, 'model_quantized.onnx')))
      .map(e => e.name)
  : [];

console.log(`\ndata in       ${DATA}`);
console.log(`${db ? yes : no}         scripture database`);
console.log(`${translations ? yes : no}         translations`);
console.log(`${indexes.length ? yes : no}         ${indexes.length} index(es)${indexes.length ? ': ' + indexes.join(', ') : ''}`);
console.log(`${models.length ? yes : no}         ${models.length} model(s)${models.length ? ': ' + models.join(', ') : ''}`);
if (db) console.log(`\n              ${mb(dirSize(DATA))} on disk`);

const tier = !db ? 1 : (translations && indexes.length > 1 ? 3 : 2);
console.log(`\ntest tier     ${tier} of 3`);
if (tier === 1) {
  console.log(`
  Runs now: everything that needs no data -- routing helpers, the vector and
  keyboard and Gurmukhi modules, the manifest registry, the auth gate, the
  portability guard. That is the suite CI requires, and it is enough to develop
  against.

  Everything else skips itself. To go further:

      npm run fetch-data -- --core-only      (~46MB)  -> tier 2
      npm run fetch-data                     (~125MB) -> tier 3`);
} else if (tier === 2) {
  console.log(`
  Runs now: the above, plus the real index -- determinism across reloads,
  JS/Python parity, latency and size budgets, and the API end to end.

  Translation tests still skip. For those:

      npm run fetch-data                     (~125MB) -> tier 3`);
} else {
  console.log(`
  Everything runs: the full suite including translations, the Darpan block and
  multi-index fusion. Two tests may still skip -- one needs network access to
  BaniDB, one needs a corpus database this repository does not ship.`);
}

if (!db) {
  console.log(`\nThe server will not start without the scripture database. Fetch it first.`);
} else {
  console.log(`\n  ARTIFACTS_DIR=${ARTIFACTS} MODELS_DIR=${MODELS} npm start`);
  if (!models.length) console.log(`\n  No model present: /api/text will return 503 and everything else works.`);
}
console.log();
