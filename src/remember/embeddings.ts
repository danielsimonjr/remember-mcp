/**
 * Lightweight, dependency-free embedding provider.
 *
 * The Python stack pulled in sentence-transformers + FAISS (~80s cold start).
 * That blew past Claude Code's MCP startup window. This hasher produces a
 * fixed-dimension unit vector from tokenized text so semantic ranking works
 * without a model download — and import stays sub-millisecond.
 *
 * A token is one of three things. (1) A run of ASCII letters and digits of two or more characters.
 * (2) A run of letters of two or more characters that holds a non-ASCII character. (3) A pair of
 * neighbouring characters of a script that writes words without a space, or the one character of a
 * run of one. A text with no token gets the vector with 1 in slot 0.
 */

const EMBED_DIM = 384;
const TOKEN_RE = /[a-z0-9_]+/gi;
// A run of letters, marks and digits of any script.
const WORD_RE = /[\p{L}\p{M}\p{N}_]+/gu;
const NON_ASCII_RE = /[^\x00-\x7f]/;
// A script that writes words without a space has no word edge to find, so its characters are paired.
const UNSPACED_RUN_RE =
  /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}]+/gu;

function murmurish(token: string, seed: number): number {
  let h = seed ^ token.length;
  for (let i = 0; i < token.length; i++) {
    h = Math.imul(h ^ token.charCodeAt(i), 0x5bd1e995);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 15), 0x1b873593);
  return h >>> 0;
}

/** The overlapping pairs of characters of `run`, or the one character of a run of one. */
function pairs(run: string): string[] {
  const chars = Array.from(run);
  if (chars.length === 1) return chars;
  const out: string[] = [];
  for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i]! + chars[i + 1]!);
  return out;
}

/** One letter is noise in every script. `length` counts UTF-16 units, so a letter beyond U+FFFF takes two. */
function isOneLetter(word: string): boolean {
  return word.length === 1 || (word.length === 2 && word.codePointAt(0)! > 0xffff);
}

function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  // ASCII text takes this path only, so its vector is the one the first version made.
  if (!NON_ASCII_RE.test(lower)) return (lower.match(TOKEN_RE) ?? []).filter((t) => t.length > 1);

  // One form for one text: a letter with its accent and the same letter with a separate accent mark must give one vector.
  const folded = lower.normalize("NFC");
  const tokens = (folded.match(TOKEN_RE) ?? []).filter((t) => t.length > 1);
  for (const run of folded.match(WORD_RE) ?? []) {
    for (const unspaced of run.match(UNSPACED_RUN_RE) ?? []) {
      // A loop, not a spread: a run can hold the 100_000 characters of the longest memory.
      for (const pair of pairs(unspaced)) tokens.push(pair);
    }
    // An ASCII-only word already has its token from TOKEN_RE.
    for (const word of run.split(UNSPACED_RUN_RE)) {
      if (NON_ASCII_RE.test(word) && !isOneLetter(word)) tokens.push(word);
    }
  }
  return tokens;
}

/** Embed `text` into a unit-length Float32Array of length EMBED_DIM. */
export function embed(text: string): Float32Array {
  const vec = new Float32Array(EMBED_DIM);
  const tokens = tokenize(text);
  if (tokens.length === 0) {
    vec[0] = 1;
    return vec;
  }

  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);

  for (const token of tokens) {
    const h1 = murmurish(token, 0x9747b28c);
    const h2 = murmurish(token, 0x85ebca6b);
    const idx = h1 % EMBED_DIM;
    const sign = (h2 & 1) === 0 ? 1 : -1;
    // Sublinear TF so repeated tokens don't dominate.
    vec[idx] += sign * (1 + Math.log(1 + counts.get(token)!));
  }

  // L2 normalize.
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBED_DIM; i++) vec[i] /= norm;
  return vec;
}

/**
 * The vector to rank a stored text by. A store written before `embed` read non-ASCII text holds the vector with 1
 * in slot 0 for a text that has no ASCII token, and that vector ranks every such text equal. For it, embed the
 * text again. Any other stored vector is returned as it is. A text that has no token at all gets the vector
 * with 1 in slot 0 again, so the repair does nothing for it.
 */
export function currentVector(stored: Float32Array, text: string): Float32Array {
  if (stored[0] !== 1) return stored;
  for (let i = 1; i < stored.length; i++) if (stored[i] !== 0) return stored;
  return embed(text);
}

/**
 * Dot product of two vectors.
 * For two unit vectors from `embed`, the dot product is the cosine similarity. The function reads only the shorter length.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}

/**
 * Wrap a vector in a `Buffer` without a copy, for storage in a SQLite BLOB.
 */
export function embeddingToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Read a stored BLOB as a `Float32Array`. A `Buffer` or an `ArrayBuffer` input is not copied.
 */
export function blobToEmbedding(blob: Buffer | Uint8Array | ArrayBuffer): Float32Array {
  if (blob instanceof ArrayBuffer) {
    return new Float32Array(blob);
  }
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

export { EMBED_DIM };
