'use strict';
/** node:sqlite adapter. The React Native adapter will implement the same shape. */
const { DatabaseSync } = require('node:sqlite');

function openNodeAdapter(dbPath, { readOnly = true } = {}) {
  const handle = new DatabaseSync(dbPath, { readOnly });
  const cache = new Map();

  const getStatement = sql => {
    let stmt = cache.get(sql);
    if (!stmt) {
      stmt = handle.prepare(sql);
      cache.set(sql, stmt);
    }
    return stmt;
  };

  return {
    all: (sql, params = []) => getStatement(sql).all(...params),
    close: () => {
      cache.clear();
      handle.close();
    },
  };
}
module.exports = { openNodeAdapter };
