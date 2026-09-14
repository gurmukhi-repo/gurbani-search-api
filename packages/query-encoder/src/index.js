'use strict';
/**
 * On-device query embedding.
 *
 * This package is an OPTIONAL peer of search-core. Line-to-line and
 * shabad-to-shabad search never touch it -- those queries are items already in
 * the corpus, so their vectors are a lookup. Only free-text search needs a
 * model, and even then nothing leaves the device.
 *
 * Each semantic index records in its manifest.json which model built it and
 * how (tokenizer, pooling, prefixes); encoderOptions() turns that into the
 * options for a QueryEncoder, so a query lands in exactly the space its index
 * lives in. Two models are in use:
 *   bge-small-en-v1.5      English index  -- WordPiece, CLS pooling, query prefix only
 *   multilingual-e5-small  Gurmukhi index -- SentencePiece Unigram, mean pooling,
 *                                            "query: " / "passage: " prefixes
 * Both run the SAME quantized .onnx file the corpus was indexed with.
 *
 * The ONNX session is injected rather than imported, so the browser
 * (onnxruntime-web) and React Native (onnxruntime-react-native) can supply
 * their own runtime without this file changing.
 */
const { WordPieceTokenizer } = require('./tokenizer.js');
const { UnigramTokenizer } = require('./unigram.js');

const DIM = 384;
const MAX_LEN = 160;
/** BGE's retrieval prefix -- the default when no options are given. */
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

/** Encoder options from an index manifest (snake_case keys as written by 02_reduce_quantize.py). */
function encoderOptions(manifest) {
  return {
    tokenizer: manifest.tokenizer,
    pooling: manifest.pooling,
    queryPrefix: manifest.query_prefix,
    docPrefix: manifest.doc_prefix,
    maxLen: manifest.max_len,
    modelDir: manifest.model_dir,
    // WordPiece normalisation, as the model's own config sets it. Absent in an
    // older manifest, where BERT's defaults were right and were hardcoded.
    lowercase: manifest.lowercase,
    stripAccents: manifest.strip_accents,
  };
}

class QueryEncoder {
  /**
   * @param {object} session  an ONNX InferenceSession (any runtime)
   * @param {object} tokenizerJson  parsed tokenizer.json
   * @param {object} ort  the runtime module, for building Tensors
   * @param {object} opts  {tokenizer, pooling, queryPrefix, docPrefix, maxLen,
   *                        lowercase, stripAccents}
   */
  constructor(session, tokenizerJson, ort, opts = {}) {
    this.session = session;
    this.ort = ort;
    const kind = opts.tokenizer || (tokenizerJson.model.type === 'Unigram' ? 'unigram' : 'wordpiece');
    this.tokenizer = kind === 'unigram'
      ? new UnigramTokenizer(tokenizerJson)
      : new WordPieceTokenizer(tokenizerJson, {
          lowercase: opts.lowercase ?? true,
          stripAccents: opts.stripAccents ?? true,
        });
    this.pooling = opts.pooling || 'cls';
    this.queryPrefix = opts.queryPrefix ?? QUERY_PREFIX;
    this.docPrefix = opts.docPrefix ?? '';
    this.maxLen = opts.maxLen ?? MAX_LEN;
    this.inputNames = new Set(session.inputNames || []);
  }

  /** Embed raw texts as DOCUMENTS (docPrefix applied). Returns Float32Array[]. */
  async encode(texts) {
    if (!texts || texts.length === 0) return [];
    return this.run(texts.map(t => this.docPrefix + t));
  }

  /** Embed a search query (queryPrefix applied). */
  async encodeQuery(text) {
    return (await this.run([this.queryPrefix + text]))[0];
  }

  async run(texts) {
    const batch = this.tokenizer.encodeBatch(texts, this.maxLen);
    const rows = batch.length;
    const width = batch[0].ids.length;
    const ids = new BigInt64Array(rows * width);
    const mask = new BigInt64Array(rows * width);
    batch.forEach((b, r) => {
      for (let i = 0; i < width; i += 1) {
        ids[r * width + i] = BigInt(b.ids[i]);
        mask[r * width + i] = BigInt(b.attentionMask[i]);
      }
    });
    const dims = [rows, width];
    const feeds = {
      input_ids: new this.ort.Tensor('int64', ids, dims),
      attention_mask: new this.ort.Tensor('int64', mask, dims),
    };
    if (this.inputNames.has('token_type_ids')) {
      feeds.token_type_ids = new this.ort.Tensor('int64', new BigInt64Array(rows * width), dims);
    }
    const output = await this.session.run(feeds);
    const hidden = output[Object.keys(output)[0]];        // (rows, width, dim)
    const dim = hidden.dims[2];

    const out = [];
    for (let r = 0; r < rows; r += 1) {
      const v = new Float32Array(dim);
      if (this.pooling === 'mean') {
        // masked mean over real tokens; padding contributes nothing
        let count = 0;
        for (let t = 0; t < width; t += 1) {
          if (!batch[r].attentionMask[t]) continue;
          count += 1;
          const base = (r * width + t) * dim;
          for (let i = 0; i < dim; i += 1) v[i] += hidden.data[base + i];
        }
        for (let i = 0; i < dim; i += 1) v[i] /= Math.max(count, 1);
      } else {
        // CLS pooling: token 0 of each row. BGE v1.5 uses CLS, not mean.
        const base = r * width * dim;
        for (let i = 0; i < dim; i += 1) v[i] = hidden.data[base + i];
      }
      out.push(l2Normalize(v));
    }
    return out;
  }
}

function l2Normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i += 1) n += v[i] * v[i];
  n = Math.sqrt(n) || 1e-12;
  for (let i = 0; i < v.length; i += 1) v[i] /= n;
  return v;
}

// createNodeEncoder lives in factory-node.js. This file must never name
// onnxruntime-node: it is the entry point (package main), so a require here
// would pull the Node runtime into any React Native bundle of this package.
module.exports = { QueryEncoder, encoderOptions, l2Normalize, QUERY_PREFIX, DIM, MAX_LEN };
