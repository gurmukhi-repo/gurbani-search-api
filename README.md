# Gurbani search API

An HTTP API over Sri Guru Granth Sahib — 60,403 lines, 5,542 shabads, 1,430 angs
— that searches by **meaning**, searches by **first letters**, reads a **shabad**
with its translations, and finds **related shabads**.

It calls no AI service at runtime and needs no credentials. Embedding happened
once, offline; the service ships frozen vectors and does arithmetic. It runs in
**149 MB of RAM** on the cheapest VPS you can rent, behind a firewall, or on a
plane.

> **Code is MIT. The data is not.** The scripture, translations and indexes come
> from BaniDB under **NPOSL-3.0** (a *non-profit* licence) and from translators
> whose terms require written permission for commercial or internet use. Read
> [NOTICE.md](NOTICE.md) before you redistribute anything or deploy commercially.

---

## 60 seconds

Needs Node 22 or newer (it uses `node:sqlite`). No database server, no build
step, no toolchain.

```bash
git clone https://github.com/gurmukhi-repo/gurbani-search-api
cd gurbani-search-api
npm install
npm run fetch-data -- --core-only     # 46MB; drop the flag for everything
npm start
```

Then, in another terminal:

```bash
curl "http://localhost:5173/api/fl?q=gnm&limit=1"
```

```json
{
  "query": "gnm", "mode": "anywhere", "total": 3, "ms": 1,
  "results": [{
    "line_id": 4, "shabad_id": 1, "ang": 1,
    "gurmukhi_uni": "ਗੁਰ ਪ੍ਰਸਾਦਿ ॥",
    "translit_roman": "gur prasaad ||",
    "first_letters_ascii": "gpq"
  }]
}
```

Start every integration with [`/api/health`](#apihealth): it tells you which
indexes this deployment loaded and what it can therefore do.

## What it answers

| | |
|---|---|
| **First-letter search** | `ਕ ਨ ਜ ਤ` → ਕੋਇ ਨ ਜਾਣੈ ਤੇਰਾ… — the SikhiToTheMax interaction |
| **Meaning search** | free text in English or Punjabi → the lines or shabads that mean it |
| **Neighbours** | a line or shabad → others that say the same thing |
| **Reading** | a shabad, its lines, its rahao stanza, and translations |

## Why it might interest you

- **The same answer forever.** The vectors are frozen int8 on disk. There is no
  model call at query time, so there is no model drift: a query that returned a
  line last year returns it today, bit for bit.
- **No network dependency of any kind.** Nothing dials out. Ever.
- **First-letter search is exact, not fuzzy** — a suffix-token index over the
  whole corpus, p95 about 1 ms.
- **Several meaning sources vote.** Under `index=all` independent indexes are
  fused by reciprocal rank, and each result carries `votes`: how many agreed.
  That is a far better trust signal than any single score.
- **A query in a script an index cannot read is refused**, with a 400, rather
  than answered badly.
- **It degrades honestly.** Leave the query model out entirely and first-letter
  search, shabad reading and all three neighbour endpoints still work;
  `/api/text` returns a clean 503 saying the encoder is unavailable.

## The endpoints

Every response is JSON. An error is `{"error": "...", "code": <status>}`.

### `GET /api/text`
Meaning search. `q` (English or Gurmukhi), `k` (1–50, default 15),
`level` (`lines` | `shabads`), `index` (a name or `all`), `tr` (`en,pa,pad,fk`).
Use `index=all` and read `votes`. The `score` is then a fusion rank
(`score_kind: "rrf"`), not a similarity — compare results to each other, never
to a threshold.

### `GET /api/fl`
First-letter search. `q` is the first letter of each word, ASCII (`gnm`) or
Gurmukhi (`ਗਨਮ`). `mode=anywhere` (default) or `start`. Exact, not fuzzy: no
results means those letters do not occur in that order.

### `GET /api/shabad`
`id` plus optional `tr`. Returns `{shabad, darpan, lines}`. Each line has a
`kind`: `line`, `rahao`, `heading` or `invocation`. **A heading is not a verse.**
The `rahao` line is the shabad's thesis — if you summarise, start there.

### `GET /api/similar/line` · `shabad` · `rahao`
`id` plus `k`. These are lookups into a frozen index, not model calls: fast,
exactly reproducible, and they work even where free-text search is unavailable.
`rahao` compares refrains, so it finds shabads on the same *theme* rather than
with similar wording.

### `GET /api/keyboard`
The Gurmukhi layout — letter rows, matras, physical-key mapping, Roman scheme —
so a client can render a keyboard without hardcoding it.

### `GET /api/health`
What this deployment can do. Never requires credentials, so it doubles as a
container health check. `sources` lists loaded indexes;
`indexes[name].freeText` says whether `/api/text` will work; `translations` says
which `tr` views exist.

Full reference: [docs/api.md](docs/api.md). Using this from an LLM:
[skills/gurbani-search/SKILL.md](skills/gurbani-search/SKILL.md).

## Configuration

Environment variables; there is no config file.

| Variable | Default | Effect |
|---|---|---|
| `PORT` | `5173` | listen port |
| `INDEXES` | all | comma list; restricts which indexes load |
| `DEFAULT_INDEX` | `en-ss` | index used when a request names none; falls back to the first loaded |
| `DB_PATH` | `$ARTIFACTS_DIR/gurbani.sqlite` | the scripture database |
| `ARTIFACTS_DIR` | `artifacts` | where index directories are discovered |
| `MODELS_DIR` | `vendor/models` | where an index's `model_dir` is resolved |
| `TRANSLATIONS_PATH` | `$ARTIFACTS_DIR/translations.sqlite` | absent → no `?tr=` |
| `APP_PASSWORD` | unset | unset → open. Set → HTTP Basic on every route except `/api/health` |
| `CORS_ORIGINS` | unset | unset → no CORS headers at all. `*` → any origin, no credentials. A comma list → only those origins, and they may send credentials |
| `RATE_LIMIT_PER_MINUTE` | unset | requests per client per minute. Unset or `0` → no limiting |
| `RATE_LIMIT_TEXT_PER_MINUTE` | = the above | a tighter ceiling for `/api/text`, the one endpoint that costs real CPU |
| `TRUST_PROXY` | `0` | how many reverse proxies sit in front. `0` ignores `X-Forwarded-For` |
| `NODE_ENV` | | `production` hides error detail from responses |

`npm run fetch-data` writes into `./data`, so point `ARTIFACTS_DIR` at
`data/artifacts` and `MODELS_DIR` at `data/models` — or use the Docker image,
where that is already the default.

## Sizing, measured

| Configuration | Resident | Data on disk |
|---|---:|---:|
| **One index** (`INDEXES=pa-ssa`), in the Docker image | **114 MB** | 84 MB |
| Everything | measure it — see [docs/deploying.md](docs/deploying.md) | 267 MB |

Each further index costs about 18 MB of vectors; indexes sharing a model share
its ONNX session, so a second Punjabi index is vectors only while the first
English one adds a whole model.

**A one-index deployment fits in 256 MB of RAM**, which puts it in the cheapest
tier of every host there is.

**Latency**: first-letter p95 ~1 ms · neighbours p95 ~15 ms · free text 25–70 ms
(the ONNX forward pass dominates) · reading a shabad ~2 ms. One shared CPU is
plenty; this needs to scale up long before it needs to scale out.

## Running it

**Docker** — the image is code only; the data is mounted:

```bash
npm run fetch-data
docker build -t gurbani-search-api .
docker run -p 8080:8080 -v "$PWD/data:/data:ro" gurbani-search-api
```

Or `docker compose up`. There are ready-made configs under
[`deploy/`](deploy/) for Fly.io and systemd, and
[docs/deploying.md](docs/deploying.md) discusses what things actually cost — the
short version being that managed container platforms bill memory-seconds and
egress for elasticity this service does not need, so a small VPS is usually
several times cheaper.

**Behind a password**: set `APP_PASSWORD`. Every route except `/api/health` then
requires HTTP Basic with any username.

## Calling it from a browser

Cross-origin access is off by default. While it is off, no response carries a
cross-origin header and `OPTIONS` is a 405 — identical to this code not existing.

```bash
# these origins only, and they may send credentials
CORS_ORIGINS=https://reader.example,http://localhost:3000 npm start

# anyone may read; credentials are never granted
CORS_ORIGINS='*' npm start
```

Matching is exact, including scheme and port: `https://a.example` and
`http://a.example` are different origins, as are `:443` and `:8443`.

**`*` never grants credentials**, and cannot. The CORS specification forbids the
combination, and allowing it would let any page on the internet read a
deployment you had protected with `APP_PASSWORD`. If a browser client needs to
sign in, name its origin rather than using `*`.

An origin that is not on the list simply gets no allowance — the API still
answers, and the *browser* is what blocks it. A preflight from such an origin is
answered 403, so the network tab tells you which of the two problems you have.

`/api/health` reports the configuration, so a blocked request can be diagnosed
without guessing:

```json
"cors": { "enabled": true, "origins": ["https://reader.example"], "credentials": true }
```

## Rate limiting

Off by default. When something else in front of you already does this — a CDN, a
gateway, a reverse proxy — leave it off.

```bash
RATE_LIMIT_PER_MINUTE=120 RATE_LIMIT_TEXT_PER_MINUTE=20 TRUST_PROXY=1 npm start
```

Free-text search runs an ONNX forward pass, 25–70 ms of CPU, while a first-letter
lookup is about 1 ms. One careless loop can saturate a shared vCPU, which is what
`RATE_LIMIT_TEXT_PER_MINUTE` is for: a *sub-ceiling*, not a second allowance. A
text request spends both budgets, and a request refused by either spends neither.

Over the limit is a **429** with `Retry-After`; every response carries
`X-RateLimit-Limit`, `-Remaining` and `-Reset`. **`/api/health` is never
counted** — a limit that can take your deployment out of rotation is worse than
no limit.

**`TRUST_PROXY` matters, and the default is the safe one.** `X-Forwarded-For` is
a list the *client* can start and each proxy appends to, so its leftmost entry is
whatever the caller claimed. Trusting that — the common shortcut — lets anyone
mint a fresh budget per request by varying a header. At `0` the header is ignored
entirely and the socket address is used. Set it to the number of proxies actually
in front of you, and the real client is read that many entries from the right.

Be clear-eyed about what this buys: it stops one client hammering the box, and it
does **not** stop a determined attacker, who will simply use more addresses. For
that you want a real WAF in front. It is also per-process and in-memory, so two
instances keep two counts.

## Known gaps

Stated up front rather than discovered:

- **No authentication beyond a shared password.** `APP_PASSWORD` is all there
  is; there are no per-user accounts or API keys.
- **No public instance.** You host it yourself; there is nothing to point a
  client at until you do.
- **No write path of any kind.** This is a read-only service over a fixed corpus.

## A note on the text

The Gurmukhi is scripture and is reproduced exactly. The translations are named
people's work and are labelled: `bdb` and `ms` in English, Sahib Singh's *Guru
Granth Darpan* and the Faridkot Teeka in Punjabi. Machine-translated text is
marked `machine` in the `translators` table and is never presented as a human
translation.

If you build something on this API, carry those labels through — the difference
between what the Guru said, what a translator said, and what a machine said is
the whole point of keeping them apart.

## Contributing

Yes, please — see [CONTRIBUTING.md](CONTRIBUTING.md). The test suite passes on a
clean clone with **no data downloaded**, so you can send a patch without
fetching 270 MB.

## Thanks

[BaniDB](https://banidb.com) and the Khalis Foundation · Dr Kulbir Thind, MD ·
Sant Singh Khalsa, MD · Prof. Sahib Singh · Manmohan Singh ·
redroyals/mahan-kosh-multilingual · BAAI · intfloat · Xenova.
