// Serialization helpers for storing values in SQLite.
//
// Embeddings are stored as raw little-endian float32 blobs. We copy into a fresh
// ArrayBuffer on both encode and decode so results never alias a pooled Node
// Buffer (which would corrupt the vector when the pool is reused).

export function embeddingToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function blobToEmbedding(blob: Buffer): Float32Array {
  const copy = new Float32Array(
    blob.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  for (let i = 0; i < copy.length; i++) {
    copy[i] = view.getFloat32(i * Float32Array.BYTES_PER_ELEMENT, true);
  }
  return copy;
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export function fromJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  return JSON.parse(text) as T;
}
