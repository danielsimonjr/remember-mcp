/**
 * Lightweight, dependency-free embedding provider.
 *
 * The Python stack pulled in sentence-transformers + FAISS (~80s cold start).
 * That blew past Claude Code's MCP startup window. This hasher produces a
 * fixed-dimension unit vector from tokenized text so semantic ranking works
 * without a model download — and import stays sub-millisecond.
 */

const EMBED_DIM = 384;
const TOKEN_RE = /[a-z0-9_]+/gi;

function murmurish(token: string, seed: number): number {
  let h = seed ^ token.length;
  for (let i = 0; i < token.length; i++) {
    h = Math.imul(h ^ token.charCodeAt(i), 0x5bd1e995);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 15), 0x1b873593);
  return h >>> 0;
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(TOKEN_RE) ?? []).filter((t) => t.length > 1);
}

/** Embed `text` into a unit-length Float32Array of length EMBED_DIM. */
export function embed(text: string): Float32Array {
  const vec = new Float32Array(EMBED_DIM);
  const tokens = tokenize(text);
  if (tokens.length === 0) {
    vec[0] = 1;
    return vec;
  }

  for (const token of tokens) {
    const h1 = murmurish(token, 0x9747b28c);
    const h2 = murmurish(token, 0x85ebca6b);
    const idx = h1 % EMBED_DIM;
    const sign = (h2 & 1) === 0 ? 1 : -1;
    // Sublinear TF so repeated tokens don't dominate.
    vec[idx] += sign * (1 + Math.log(1 + tokens.filter((t) => t === token).length));
  }

  // L2 normalize.
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBED_DIM; i++) vec[i] /= norm;
  return vec;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}

export function embeddingToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function blobToEmbedding(blob: Buffer | Uint8Array | ArrayBuffer): Float32Array {
  if (blob instanceof ArrayBuffer) {
    return new Float32Array(blob);
  }
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

export { EMBED_DIM };
