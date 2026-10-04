// Embedding is pluggable. The zero-config default is a dependency-free,
// deterministic hashing embedder: it needs no model download, runs offline, and
// makes tests hermetic. It is a real (if weak) bag-of-words vector, good enough
// to build and test the storage and ingest paths against.
//
// For production recall quality, opt into TransformersEmbedder (./transformers),
// which runs a local sentence-transformer model on the user's machine (no API,
// offline after the first weight download). It keeps the model of the user on
// the device, matching the local-first, sovereign design stance.

export interface Embedder {
  readonly dim: number;
  embed(text: string): Promise<Float32Array>;
}

// FNV-1a, used only to spread tokens across buckets. Not security-sensitive.
function hashToken(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

export interface HashingEmbedderOptions {
  dim?: number;
}

export class HashingEmbedder implements Embedder {
  readonly dim: number;

  constructor(opts: HashingEmbedderOptions = {}) {
    this.dim = opts.dim ?? 256;
  }

  async embed(text: string): Promise<Float32Array> {
    const vec = new Float32Array(this.dim);
    const tokens = tokenize(text);
    for (const token of tokens) {
      const idx = hashToken(token) % this.dim;
      // A single non-null index means the write is always in bounds.
      vec[idx] = (vec[idx] as number) + 1;
    }
    // L2 normalize so cosine similarity is a plain dot product downstream.
    let norm = 0;
    for (let i = 0; i < this.dim; i++) norm += (vec[i] as number) ** 2;
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < this.dim; i++) {
        vec[i] = (vec[i] as number) / norm;
      }
    }
    return vec;
  }
}
