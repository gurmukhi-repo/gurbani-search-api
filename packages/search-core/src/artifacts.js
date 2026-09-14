'use strict';
/**
 * Artifact loading.
 *
 * The only I/O dependency is an injected `readFile(name) -> ArrayBuffer|Uint8Array`,
 * so the same loader serves Node (fs), the browser (fetch) and React Native
 * (bundled asset reads) without conditional imports.
 */
const { loadIndex } = require('./vectors.js');

const toArrayBuffer = b => {
  if (b instanceof ArrayBuffer) return b;
  // A view that already owns its whole buffer needs no copy. React Native's
  // File.bytes() returns exactly that, and lines.i8 is 15MB, so this is the
  // difference between ~34MB and ~19MB of peak memory per index on a phone.
  // A Node Buffer is a view into a shared pool and still takes the slice.
  if (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength) return b.buffer;
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

/**
 * @param {(name:string)=>Promise<ArrayBuffer|Uint8Array>} readFile
 * @param {object} [opts]  { semantic: false } loads manifest only -- used to
 *   prove the lexical half runs with the vector artifacts absent.
 */
async function loadArtifacts(readFile, opts = {}) {
  const manifest = JSON.parse(new TextDecoder().decode(
    new Uint8Array(toArrayBuffer(await readFile('manifest.json')))));

  if (opts.semantic === false) return { manifest, lines: null, shabads: null, rahao: null, pca: null };

  const dim = manifest.index_dim;
  const get = async n => toArrayBuffer(await readFile(n));

  const lines = loadIndex({
    codesBuf: await get('lines.i8'),
    scalesBuf: await get('lines.scale.f32'),
    maskBuf: await get('lines.mask.u8'),
    dim,
  });
  const shabads = loadIndex({
    codesBuf: await get('shabads.i8'),
    scalesBuf: await get('shabads.scale.f32'),
    idsBuf: await get('shabads.ids.i32'),
    dim,
  });
  const rahao = loadIndex({
    codesBuf: await get('rahao.i8'),
    scalesBuf: await get('rahao.scale.f32'),
    idsBuf: await get('rahao.ids.i32'),
    dim,
  });
  const pca = {
    components: new Float32Array(await get('pca.components.f32')), // (index_dim, embed_dim)
    mean: new Float32Array(await get('pca.mean.f32')),             // (embed_dim)
    inDim: manifest.embed_dim,
    outDim: dim,
  };
  return { manifest, lines, shabads, rahao, pca };
}

/**
 * Apply the persisted PCA projection to a freshly embedded query, then
 * L2-normalize. A fixed linear map -- identical on every device.
 */
function projectQuery(pca, embedding) {
  const { components, mean, inDim, outDim } = pca;
  if (embedding.length !== inDim) throw new Error(`embedding dim ${embedding.length} != ${inDim}`);
  const centered = new Float32Array(inDim);
  for (let i = 0; i < inDim; i += 1) centered[i] = embedding[i] - mean[i];
  const out = new Float32Array(outDim);
  for (let c = 0; c < outDim; c += 1) {
    let acc = 0;
    const base = c * inDim;
    for (let i = 0; i < inDim; i += 1) acc += components[base + i] * centered[i];
    out[c] = acc;
  }
  let norm = 0;
  for (let i = 0; i < outDim; i += 1) norm += out[i] * out[i];
  norm = Math.sqrt(norm) || 1e-12;
  for (let i = 0; i < outDim; i += 1) out[i] /= norm;
  return out;
}

// nodeReadFile lives in io-node.js. Metro collects require('node:fs') even from
// inside a function body, so keeping it here would make this file -- the one a
// phone must import -- impossible to bundle.
module.exports = { loadArtifacts, projectQuery };
