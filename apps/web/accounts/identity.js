'use strict';
/**
 * Who is asking.
 *
 * One scheme:
 *
 *   Basic <anything>:<password>   the owner, against APP_PASSWORD
 *
 * With APP_PASSWORD unset the server is open, which is the right default for a
 * microservice sitting behind your own gateway, and the same behaviour this
 * code has always had for local development.
 *
 * `createIdentifier` returns a function with the exact shape server.js expects
 * -- `identify(req)`, `identify.challenge()`, `identify.enabled`,
 * `identify.accounts` -- so the credential gate in server.js is byte-identical
 * to the one in the project this was extracted from. If you want real accounts,
 * implement them here and nothing else has to change.
 *
 * Note /api/health is exempt from this gate in server.js, deliberately: a host's
 * health check must not need credentials.
 */
const crypto = require('node:crypto');

/**
 * Constant-time password check.
 *
 * Both sides are hashed first so that timingSafeEqual gets two equal-length
 * buffers (it throws otherwise, and the length of the throw is itself a signal),
 * and so comparison time does not depend on how many leading characters
 * matched.
 */
function checkBasic(header, password) {
  if (!header.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    const given = colonIdx === -1 ? '' : decoded.slice(colonIdx + 1);
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(password).digest();
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * @returns {(req) => Promise<{kind, id} | null>} null means "not authorised".
 */
function createIdentifier(env = process.env) {
  const password = env.APP_PASSWORD || '';

  // async because server.js awaits it, and because a real implementation of
  // this seam (a token check against a key server) would have to be.
  const identify = async req => {
    const header = (req.headers && req.headers.authorization) || '';
    if (password) return checkBasic(header, password) ? { kind: 'owner', id: 'owner' } : null;
    return { kind: 'owner', id: 'owner' };    // nothing configured: open
  };

  identify.challenge = () => 'Basic realm="Gurbani search API", charset="UTF-8"';
  identify.enabled = Boolean(password);
  // No per-account identity here, so every caller is the owner. server.js reads
  // this to decide whether to key limits on an account or on an address.
  identify.accounts = false;
  return identify;
}

module.exports = { createIdentifier, checkBasic };
