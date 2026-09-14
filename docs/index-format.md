# The index format

This is the contract between whatever builds an index and the server that serves
it. It is written down so you can **build your own** — for another translation,
another language, another model — and have this server load it without changing
a line of code.

The pipeline that builds the shipped indexes is not part of this repository. The
format is, completely, and it is the only thing the server knows about.

---

## An index is a directory

The server discovers indexes at startup: every immediate subdirectory of
`ARTIFACTS_DIR` that contains a `manifest.json`, plus `ARTIFACTS_DIR` itself.
**The manifest's `index` field is the id**, not the folder name; if they
disagree, the server warns and the manifest wins. A duplicate id is refused
rather than silently shadowing.

Twelve files, all required:

```
<index>/
  manifest.json          what this is, and how to encode a query for it
  lines.i8               N x D   int8     line vectors, row == line_id
  lines.scale.f32        N       float32  per-vector scale
  lines.mask.u8          N       uint8    1 = retrievable, 0 = excluded
  shabads.i8             S x D   int8     one vector per shabad
  shabads.scale.f32      S       float32
  shabads.ids.i32        S       int32    row -> shabad_id
  rahao.i8              R x D   int8     one vector per refrain
  rahao.scale.f32       R       float32
  rahao.ids.i32         R       int32    row -> shabad_id
  pca.components.f32    E x D   float32  the projection
  pca.mean.f32          E       float32  subtracted before projecting
```

Optionally, `agreement.<translator>.f32` — N float32, one per line, `NaN` where
either side has no text. The server picks these up by filename and exposes them
on `/api/shabad`.

All numeric files are **little-endian, C-ordered, no header**. `D` is
`index_dim` from the manifest and `E` is `embed_dim`. For the shipped indexes
D = 256 and E = 384.

**`lines.i8` row order is `line_id`.** There is no id map for lines, because the
corpus is dense: row *i* is line *i*. That is also why an index is only valid
against the data release it was built for — a `line_id` that shifted would render
the wrong verse while looking entirely healthy. `shabads` and `rahao` are sparse,
so those carry explicit `.ids.i32` maps.

**`lines.mask.u8` is why a heading never appears in results.** A `0` means the
line is excluded from semantic retrieval: a heading, an invocation, or a line the
source has no text for. `/api/similar/line` on a masked line returns
`{"results": [], "note": "this line has no text in this source"}` — not an error.

---

## Reading a vector

```
v[d] = lines.i8[row * D + d] * lines.scale.f32[row]
```

Per-vector scale, not per-tensor. Cosine between the float32 original and the
int8 reconstruction is **0.9999** on the shipped indexes (the manifest records
the measured `min_cosine` and `mean_cosine`), which is far below the margin
between any two competing results — but it is not zero, so a fixture comparing
an int8 index against float32 references must use a tolerance. See *Conformance*.

## Encoding a query

```
e = encode(query_prefix + text)        # E dims, mean-pooled, L2-normalised
e = e - pca.mean.f32                   # E
q = e @ pca.components.f32             # E x D -> D
score = dot(q, dequantised row)
```

`pca.components.f32` is `E x D` row-major. The same projection was applied to the
documents at build time, so query and document land in the same space.

---

## The manifest

| Field | | |
|---|---|---|
| `index` | **required** | the id used in `?index=` and in `INDEXES` |
| `index_dim` | **required** | D — vector width on disk |
| `embed_dim` | **required** | E — the model's native width |
| `model_dir` | **required for free text** | resolved under `MODELS_DIR`; omit and the index is neighbours-only |
| `tokenizer` | `wordpiece` \| `unigram` | must match the model |
| `pooling` | `mean` | |
| `query_prefix`, `doc_prefix` | e.g. `"query: "`, `"passage: "` | e5 needs these; bge does not |
| `max_len` | e.g. `160` | truncation length |
| `pad_id`, `pad_token`, `lowercase`, `strip_accents` | | |
| `text_source` | | what was embedded — `gurmukhi_uni`, a translator id, or a comma list |
| `text_lang` | `pa` \| `en` | the language of the **text** |
| `query_scripts` | `["gurmukhi","latin"]` | which scripts a **query** may use |
| `roles` | `["neighbours","text"]` | `[]` means the server never loads it |
| `label`, `label_pa`, `order` | | presentation |
| `lines`, `shabads`, `lines_with_text` | | row counts, cross-checked at load |

**`query_scripts` is enforced, and that matters.** A Gurmukhi query sent to an
index whose tokenizer is English WordPiece renders every letter `[UNK]` and
returns confident nonsense. The server answers **400** instead. Declare this
honestly for your index.

**`lowercase` and `strip_accents` must be `false` for an Indic model.** A
Gurmukhi matra is a combining mark, and accent stripping deletes it — silently
changing the word.

**`roles: []`** is how you keep an experimental index in the directory without
the server loading it.

---

## Conformance

A new index is correct when the query encoder you built it with and the one this
server runs agree. Test that directly rather than trusting it:

1. **Tokenizer parity** — the same text must produce the same token ids in your
   builder and in `packages/query-encoder`. A mismatch here is the failure that
   looks like "search is a bit worse" rather than an error.
2. **Embedding parity** — the same text must produce the same vector to about
   1e-4. Anything larger means a pooling, prefix or normalisation difference.
3. **Retrieval parity** — run a set of known queries through both. The shipped
   indexes are checked with the rule **top-1 must match and at least 8 of the top
   10 must overlap**; int8 quantisation perturbs a score by around 5e-4, which is
   enough to reorder genuine ties and not enough to move a real result.

Ship those fixtures beside your index if you want the parity tests to cover it.

---

## What this format is not

There is **no approximate nearest neighbour structure**, no BM25, no inverted
file. A full scan of 60,403 × 256 int8 is about 15.5 million multiply-accumulates
and finishes in single-digit milliseconds; an ANN index would add a build
dependency, a tuning parameter and a recall cliff to save time nobody is waiting
for.

The consequence worth knowing: cost is linear in corpus size. At ten times this
corpus you would want a different structure. At this one, exactness is free.

Determinism is deliberate. Frozen vectors and integer arithmetic mean a query
returns the same lines in the same order forever, on any machine — which is what
makes the parity fixtures above meaningful in the first place.
