'use strict';
/**
 * Stanza boundaries inside a shabad, for display.
 *
 * A shabad is sung as a set of antaras (stanzas), each closed by its counter
 * (॥੧॥, ॥੪॥੨॥), around one rahao stanza -- the asthaayee, the refrain that
 * returns after every antara and carries the shabad's central thought. BaniDB
 * marks only the verse bearing the ਰਹਾਉ marker, which is the LAST line of that
 * stanza; the lines above it, back to the previous counter, belong to it just
 * as much. The reader should see the whole refrain, not its final line.
 *
 * The counter is matched as a whole danda-delimited tail, never as a substring,
 * and the rahao line itself is never a counter line: it ends `॥੧॥ ਰਹਾਉ ॥`.
 * Mirrors pipeline/python/lib/gurmukhi_text.py:is_stanza_end.
 */

const STANZA_END = /॥\s*[੦-੯]+(?:\s*॥\s*[੦-੯]+)*\s*॥\s*$/;

/** Does this line close a stanza? 'ਨਾਨਕ ਲਿਖਿਆ ਨਾਲਿ ॥੧॥' -> true */
function isStanzaEnd(gurmukhiUni) {
  return STANZA_END.test(String(gurmukhiUni || '').trim());
}

/**
 * Which lines of a shabad belong to a rahao stanza.
 *
 * @param {Array<{gurmukhi_uni: string, kind: string}>} lines  in shabad order
 * @returns {boolean[]} one flag per line, true inside a rahao stanza
 */
function rahaoStanzaFlags(lines) {
  const flags = lines.map(() => false);
  lines.forEach((line, i) => {
    if (line.kind !== 'rahao') return;
    flags[i] = true;
    for (let j = i - 1; j >= 0; j -= 1) {
      const prev = lines[j];
      // the stanza reaches back to the previous counter, the previous rahao,
      // or the heading that opens the shabad -- whichever comes first
      if (prev.kind !== 'line' || isStanzaEnd(prev.gurmukhi_uni)) break;
      flags[j] = true;
    }
  });
  return flags;
}

module.exports = { STANZA_END, isStanzaEnd, rahaoStanzaFlags };
