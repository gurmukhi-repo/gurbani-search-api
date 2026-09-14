'use strict';
/**
 * Request logging, off unless asked for.
 *
 *   LOG_REQUESTS=json   one JSON object per line, for a log aggregator
 *   LOG_REQUESTS=text   one human-readable line, for a terminal
 *   LOG_REQUESTS unset  nothing, which is what a local run wants
 *
 *   LOG_QUERIES=1       include the `q` parameter (see below)
 *
 * WHAT IS NOT LOGGED, AND WHY. The search terms are omitted by default. `q` is
 * what a person asked Gurbani about -- grief, illness, a decision they are
 * struggling with -- and a log line pairing that with an IP address and a
 * timestamp is a record of someone's private religious enquiry. It is rarely
 * needed to operate the service, so it is opt-in rather than opt-out, and the
 * decision is the operator's to make knowingly.
 *
 * The Authorization header is never logged in any mode.
 *
 * Client addresses are logged, because an access log without them cannot answer
 * "who is hammering this". If that is not acceptable where you are deploying,
 * leave logging off and let your reverse proxy do it under its own policy.
 */

/** Everything except `q`, so a log line still says which index and how many. */
function safeQuery(search, includeQ) {
  const p = new URLSearchParams(search);
  if (!includeQ) p.delete('q');
  const s = p.toString();
  return s ? '?' + s : '';
}

function createLogger(env = process.env, out = console) {
  const mode = String(env.LOG_REQUESTS || '').trim().toLowerCase();
  const enabled = mode === 'json' || mode === 'text';
  const includeQ = env.LOG_QUERIES === '1' || env.LOG_QUERIES === 'true';

  if (enabled && includeQ) {
    out.warn('LOG_QUERIES is on: search terms will be written to the log. '
      + 'They are what people asked about, so treat the log accordingly.');
  }

  /**
   * Call once per request, after the response is decided.
   * @param {{method,url,client}} req  `client` is the key the limiter derived,
   *        so both agree on who this is rather than computing it twice.
   */
  const log = (req, status, ms, bytes) => {
    if (!enabled) return;
    const [path, search = ''] = String(req.url || '').split('?');
    if (mode === 'json') {
      out.log(JSON.stringify({
        t: new Date().toISOString(),
        method: req.method, path,
        query: safeQuery(search, includeQ) || undefined,
        status, ms, bytes,
        client: req.client,
      }));
    } else {
      out.log(`${new Date().toISOString()} ${req.client} ${req.method} ${path}`
        + `${safeQuery(search, includeQ)} ${status} ${ms}ms ${bytes}b`);
    }
  };

  log.enabled = enabled;
  log.summary = () => (enabled ? { enabled: true, format: mode, queries: includeQ } : { enabled: false });
  return log;
}

module.exports = { createLogger, safeQuery };
