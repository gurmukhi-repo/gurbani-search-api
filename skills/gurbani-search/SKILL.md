---
name: gurbani-search
description: Search Sri Guru Granth Sahib by meaning or by first letters, read a shabad with its translations, and find related shabads, through a self-hosted HTTP API. Use when someone asks what Gurbani says about something, quotes or half-remembers a line, names an ang or a shabad, or wants the Punjabi or English meaning of a verse.
---

# Gurbani search

An HTTP API over Sri Guru Granth Sahib: 60,403 lines, 1,430 angs, 5,542 shabads,
with English and Punjabi translations and Prof. Sahib Singh's Guru Granth Darpan.

Set `GURBANI_API` to the base URL (for example `http://localhost:5173`). Every
response is JSON; an error is `{"error": "...", "code": <status>}`. If the
deployment sets a password, send HTTP Basic with any username.

## Before anything else

Read this, because the failure it prevents is the one that matters.

**Never write Gurmukhi from memory.** Quote only `gurmukhi_uni` exactly as the
API returned it, and give the `ang` with it. A plausible-looking line you
generated is not a line of the Guru Granth Sahib, and a reader has no way to
tell the difference. If you cannot find a line, say you could not find it.

**Keep the three voices apart.** The Gurmukhi is scripture. A translation is a
named person's reading of it — `tr_en` is BaniDB's or Manmohan Singh's English,
`tr_pa` is Sahib Singh's or Manmohan Singh's Punjabi. Your own summary is a
third thing. Attribute each: "Guru Nanak says X" is a claim about scripture;
"the translation renders this as X" is a claim about a translator. Do not
promote your paraphrase into the Guru's mouth.

**Answer from what you retrieved.** If the results do not address the question,
say so rather than filling the gap from memory. Gurbani is widely misquoted
online, so what you half-remember is a poor source.

## Which endpoint

| The person… | Use |
|---|---|
| asks what Gurbani says about a subject | `/api/text` |
| quotes or half-remembers a line in Gurmukhi | `/api/text` (it reads Gurmukhi too) |
| gives first letters, or is searching a phrase they can only partly recall | `/api/fl` |
| names a shabad or wants the full text around a line | `/api/shabad` |
| asks what else is like this | `/api/similar/shabad` or `/api/similar/line` |

---

## `GET /api/text` — search by meaning

The main entry point. Free text in English or Punjabi.

```
GET {GURBANI_API}/api/text?q=how+do+I+overcome+the+fear+of+death&k=8&index=all&tr=en,pa
```

| Parameter | |
|---|---|
| `q` | the query, English or Gurmukhi |
| `k` | how many results, 1–50, default 15 |
| `level` | `lines` (default) or `shabads` — use `shabads` for thematic questions |
| `index` | `all` (recommended), or one index name |
| `tr` | `en`, `pa`, `pad`, `fk` — which translations to attach |

**Use `index=all`.** Several independent meaning sources then vote, and each
result carries `votes` — how many agreed. A result with 3 votes is far more
trustworthy than one with 1. With `index=all` the `score` is a fusion rank
(`score_kind: "rrf"`), so its absolute value means nothing; compare results to
each other, not to a threshold.

A response:

```json
{
  "index": "all",
  "indexes": ["en-ss", "pa-ssa", "ss-en", "ss-pa", "pa-ft"],
  "score_kind": "rrf", "query": "fear of death", "level": "lines", "ms": 140,
  "results": [{
    "line_id": 13203, "shabad_id": 1054, "ang": 291,
    "gurmukhi_uni": "ਤਬ ਜਮ ਕੀ ਤ੍ਰਾਸ ਕਹਹੁ ਕਿਸੁ ਹੋਇ ॥",
    "translit_roman": "tab jam kee traas kahahu kis hoi ||",
    "kind": "line", "score": 0.032787, "votes": 2,
    "tr_en": "then who was afraid of death?",
    "tr_pa": "ਤਦੋਂ ਦੱਸੋ, ਮੌਤ ਦਾ ਡਰ ਕਿਸ ਨੂੰ ਹੋ ਸਕਦਾ ਸੀ ?"
  }]
}
```

A single line is often a fragment of an argument. When the question is thematic,
either ask for `level=shabads`, or take the `shabad_id` of a good line and fetch
the whole shabad — quoting one line out of its shabad can invert its meaning.

## `GET /api/fl` — search by first letters

For a half-remembered phrase. `q` is the first letter of each word, in ASCII
(`gnm`) or Gurmukhi (`ਗਨਮ`).

```
GET {GURBANI_API}/api/fl?q=gnm&limit=10&tr=en
```

`mode=anywhere` (default) matches the letters anywhere in the line;
`mode=start` only from the first word. `total` is how many lines matched in all,
which is often more than `limit`.

This is exact, not fuzzy. No results means those letters do not occur in that
order — try fewer letters, or `/api/text` instead.

## `GET /api/shabad` — read a whole shabad

```
GET {GURBANI_API}/api/shabad?id=81&tr=en,pa
```

Returns `{shabad, darpan, lines}`:

- **`shabad`** — `writer`, `raag`, `ang_start`, `ang_end`, `line_count`,
  `has_rahao`.
- **`lines`** — each with `gurmukhi_uni`, `translit_roman`, `kind`, and the
  `tr_*` you asked for. `kind` is `line`, `rahao`, `heading` (the raag and
  author line) or `invocation` (ੴ and similar). **A heading is not a verse** —
  never quote one as though the Guru said it.
- **`rahao_stanza`** on a line means it belongs to the refrain's stanza.
- **`darpan`** — when the deployment has translations: Sahib Singh's `bhav` (the
  central point of the shabad), his per-stanza `stanzas` arth, and the `topics`
  he filed it under.

**The rahao line is the thesis.** `॥ ਰਹਾਉ ॥` marks the line that states what the
shabad is about; everything else elaborates it. If you summarise a shabad, start
from its rahao.

## `GET /api/similar/shabad|line|rahao` — what else says this

```
GET {GURBANI_API}/api/similar/shabad?id=81&k=5
GET {GURBANI_API}/api/similar/line?id=13203&k=5
GET {GURBANI_API}/api/similar/rahao?id=81&k=5
```

`rahao` compares refrains, so it finds shabads on the same *theme* rather than
with similar wording — the best of the three for "what else teaches this".

These are lookups into a frozen index, not a model call: they are fast, exactly
reproducible, and work even where free-text search is unavailable. A response of
`{"results": [], "note": "..."}` means that line has no text in the chosen
source, which is not an error.

## `GET /api/health` — what this deployment can do

Check it once before relying on anything. `sources` lists the loaded indexes;
`indexes[name].freeText` says whether `/api/text` will work; `translations` says
which `tr` views exist. A deployment with no translations still searches and
reads — plan for `tr_en` simply being absent.

---

## Working well

**Start broad, then narrow.** `/api/text` with `index=all` and `level=shabads`
to find the territory, then `/api/shabad` on the best hit to read it properly,
then `/api/similar/rahao` if they want more.

**Prefer several sources over one.** Two of the meaning indexes read the Gurmukhi
itself and three read translations; they disagree usefully. `votes` is the
cheapest signal you have about whether a result is really on topic.

**Give the ang.** It is how a reader finds the line in a physical Guru Granth
Sahib, and it is the citation that makes your answer checkable.

**Transliteration is provided.** `translit_roman` is in the response — use it for
a reader who cannot read Gurmukhi, rather than inventing a romanisation.

**When results are thin, say so.** Some questions are not addressed in Gurbani
in the terms they were asked, and reporting that honestly is more useful than
stretching a loosely-related verse to fit.

## Getting it wrong

- Quoting Gurmukhi you did not retrieve — the single worst failure here.
- Citing a `heading` or `invocation` line as a verse.
- Quoting one line of a shabad whose rahao says something different.
- Treating a machine-translated gloss as a human translation. Machine text is
  marked `machine` in the `translators` table and is a search aid, not a reading.
- Reading meaning into the `score` under `index=all`. It is a rank, not a
  similarity.
- Answering a doctrinal or personal religious question as though the API settles
  it. You can report what the text says and who translated it that way; what it
  means for someone's life is theirs and their sangat's, not yours.
