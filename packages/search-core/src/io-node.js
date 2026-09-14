'use strict';
/**
 * Node's half of artifact loading.
 *
 * artifacts.js takes an injected readFile so one loader serves Node, a browser
 * and React Native. That promise is only kept if the module itself never
 * mentions node:fs -- Metro's dependency collector is static and walks function
 * bodies, so a require() inside a lazily-called function still enters the
 * bundle graph and still fails to resolve on a phone. So the Node reader lives
 * here, next to adapter-node.js, and nothing a device imports can reach it.
 */
const fs = require('node:fs/promises');
const path = require('node:path');

/** @returns {(name: string) => Promise<Buffer>} a reader over one index directory. */
function nodeReadFile(dir) {
  return async name => fs.readFile(path.join(dir, name));
}

module.exports = { nodeReadFile };
