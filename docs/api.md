# API reference

Base URL is wherever you deployed it. Every response is JSON. Errors are
`{"error": "...", "code": <status>}` and the HTTP status matches `code`.

Only `GET` and `HEAD` are accepted; anything else is **405**. If `APP_PASSWORD`
is set, every route except `/api/health` requires HTTP Basic with any username.

**Start with `/api/health`.** It tells you which indexes this deployment loaded,
which of them can do free-text search, and which translations exist. A
deployment with one index and no translations is a perfectly normal deployment,
and a client that assumes five indexes and `tr_en` will break on it.

---

## `GET /api/health`

Never requires credentials, so it works as a container health check.

```json
{
  "ok": true,
  "lines": 60403,
  "indexes": { "pa-ssa": { "loaded": true, "freeText": true, "text_lang": "pa",
                           "query_scripts": ["gurmukhi", "latin"], "roles": ["neighbours","text","ask"],
                           "label": "...", "order": 15, "agreement": null } },
  "sources": ["pa-ssa"],
  "default_index": "pa-ssa",
  "translations": { "en": true, "pa": true, "pad": true, "fk": true },
  "semantic": true,
  "freeText": true
}
```

`sources` is the loaded indexes in display order. `default_index` is what a
request that names no index gets — note it is *resolved*, so if the configured
`DEFAULT_INDEX` did not load, this reports the one that took over.

---

## `GET /api/text` — search by meaning

| Parameter | Default | |
|---|---|---|
| `q` | — | the query, English or Gurmukhi. Empty returns no results, not an error |
| `k` | 15 | 1–50 |
| `level` | `lines` | or `shabads` — use `shabads` for thematic questions |
| `index` | the default | an index name, or `all` |
| `tr` | none | `en`, `pa`, `pad`, `fk`, comma-separated (`level=lines` only) |

```
GET /api/text?q=how+do+I+overcome+the+fear+of+death&k=8&index=all&tr=en,pa
```

**Use `index=all`.** Every loaded index that has a query encoder and can read the
query's script votes, and the lists are fused by reciprocal rank. Each result
then carries `votes` — how many sources agreed. That is the most useful trust
signal the API gives you.

```json
{
  "index": "all", "indexes": ["en-ss", "pa-ssa", "pa-ft"],
  "score_kind": "rrf", "query": "fear of death", "level": "lines", "ms": 140,
  "results": [{
    "line_id": 13203, "shabad_id": 1054, "ang": 291,
    "gurmukhi_uni": "ਤਬ ਜਮ ਕੀ ਤ੍ਰਾਸ ਕਹਹੁ ਕਿਸੁ ਹੋਇ ॥",
    "translit_roman": "tab jam kee traas kahahu kis hoi ||",
    "kind": "line", "score": 0.032787, "votes": 2,
    "tr_en": "then who was afraid of death?"
  }]
}
```

**`score_kind` decides how to read `score`.** With one index it is a cosine
similarity and comparable across queries. With `index=all` it is `"rrf"` — a
fusion rank whose absolute value means nothing. Compare results to each other,
never to a threshold.

**A query in a script the index cannot read is a 400**, not a bad answer. A
Gurmukhi query against an English index would otherwise reach a WordPiece
tokenizer that renders every letter as `[UNK]` and returns confident nonsense.
`index=all` filters to capable indexes instead, and returns 503 if none can read
it.

Needs a query model. Without one: **503**, and every other endpoint still works.

---

## `GET /api/fl` — search by first letters

| Parameter | Default | |
|---|---|---|
| `q` | — | first letter of each word, ASCII (`gnm`) or Gurmukhi (`ਗਨਮ`) |
| `limit` | 25 | 1–100 |
| `mode` | `anywhere` | or `start`, matching only from the first word |
| `tr` | none | as above |

Exact, not fuzzy. No results means those letters do not occur in that order —
try fewer, or use `/api/text`. `total` is how many lines matched in all, which is
often more than `limit`. Each result carries `highlight`, the words your letters
matched.

This is a lexical index: no model, no vectors, p95 about 1 ms.

---

## `GET /api/shabad` — read a whole shabad

| Parameter | |
|---|---|
| `id` | required; a `shabad_id` |
| `tr` | `en`, `pa`, `pad`, `fk` |
| `index` | which index's translator-agreement to attach |

Returns `{shabad, darpan, lines}`.

`shabad` has `writer`, `raag`, `ang_start`, `ang_end`, `line_count`,
`rahao_count`, `has_rahao`.

`lines` are in reading order, each with `gurmukhi_uni`, `translit_roman`,
`gurmukhi_ascii`, `ang`, `kind` and any `tr_*` you asked for.

**`kind` is one of `line`, `rahao`, `heading`, `invocation`.** A `heading` is the
raag-and-author line and an `invocation` is ੴ and similar. **Neither is a verse**
— never quote one as though the Guru said it.

**`rahao_stanza: true`** marks every line of the refrain's stanza. BaniDB marks
only the line carrying the `॥ ਰਹਾਉ ॥` marker, which is the stanza's *last* line,
so the flag is computed to cover the whole thing.

**The rahao is the shabad's thesis.** It states what the shabad is about and
everything else elaborates it. If you summarise a shabad, start there.

`darpan` is present when the deployment has translations: Prof. Sahib Singh's
`bhav` (the central point), his per-stanza `stanzas`, and the `topics` he filed
it under. His ਨੋਟ side notes are **not** included and are not available anywhere
— see [NOTICE.md](../NOTICE.md).

---

## `GET /api/similar/line` · `shabad` · `rahao` — neighbours

| Parameter | Default | |
|---|---|---|
| `id` | required | a `line_id` or `shabad_id` |
| `k` | 10 | 1–50 |
| `index` | the default | or `all`, fused like `/api/text` |

```
GET /api/similar/rahao?id=81&k=5
```

- **`line`** — lines that say the same thing.
- **`shabad`** — whole shabads, compared by their composed vector.
- **`rahao`** — compares *refrains*, so it finds shabads on the same **theme**
  rather than with similar wording. The best of the three for "what else teaches
  this".

These are lookups into a frozen index, not model calls: fast, exactly
reproducible, and **they work with no query model installed**, because the item
is already in the index and its vector is read rather than computed.

`{"results": [], "note": "this line has no text in this source"}` is not an
error: a heading, or a line a translation skips, has no vector in that index.
`"this shabad has no rahao line"` likewise.

---

## `GET /api/keyboard`

The Gurmukhi layout, so a client need not hardcode it: `rows` (the 35 akhar),
`nukta`, `matras`, `keymap` (physical key → letter, the AnmolLipi mapping
SikhiToTheMax users already know), and `roman` / `romanKeymap` for a reader who
knows the language but not the script.

---

## Field notes

**`line_id` is dense and stable** within a data release — it is the row order of
the corpus, and every index addresses lines by it. Across a *major* data release
it may change; `/api/health` and the data manifest both carry a version.

**`agreement`**, when present on a line, is how closely two translators agreed
about it, as a float. Below about 0.6 means "readings differ", which is
interesting to show and dishonest to hide.

**Translations never come back in bulk.** `?tr=` attaches text only to the lines
in the response. There is no endpoint that returns the translation corpus, by
design.
