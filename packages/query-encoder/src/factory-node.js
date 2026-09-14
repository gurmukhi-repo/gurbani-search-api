'use strict';
/**
 * Building a QueryEncoder on Node.
 *
 * index.js takes an injected ONNX session and runtime so the browser
 * (onnxruntime-web) and React Native (onnxruntime-react-native) can supply
 * their own. That only holds if index.js itself never names onnxruntime-node:
 * Metro's dependency collector is static and walks function bodies, so a lazy
 * require inside a factory still enters the bundle graph and still fails to
 * resolve on a phone -- and since `main` is index.js, importing the package at
 * all would drag the Node runtime in.
 */
const fs = require('node:fs');
const path = require('node:path');
const { QueryEncoder } = require('./index.js');

/** Node convenience factory. Browser/RN construct QueryEncoder directly. */
async function createNodeEncoder(modelDir, opts = {}) {
  // onnxruntime-node ships a Microsoft telemetry client (libcurl, HTTPS upload,
  // persisted device id). This app promises no outside calls, so switch it off
  // before the native runtime initializes. An explicit value set by the
  // operator still wins.
  if (process.env.ORT_DISABLE_TELEMETRY === undefined) process.env.ORT_DISABLE_TELEMETRY = '1';
  const ort = require('onnxruntime-node');
  const session = await ort.InferenceSession.create(
    path.join(modelDir, 'model_quantized.onnx'),
    { executionProviders: ['cpu'], graphOptimizationLevel: 'all' });
  const tokenizerJson = JSON.parse(
    fs.readFileSync(path.join(modelDir, 'tokenizer.json'), 'utf8'));
  return new QueryEncoder(session, tokenizerJson, ort, opts);
}

module.exports = { createNodeEncoder };
