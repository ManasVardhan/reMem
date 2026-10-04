// Choosing the embedder, and making sure a store is only ever read with the one
// that wrote it.
//
// Vectors from two different embedders are not comparable. Compare a
// transformer query vector against hashed document vectors and every score is
// noise, silently: nothing errors, recall simply returns the wrong things
// forever. So the store records which embedder produced it, and readers match
// that rather than picking their own.

import type { DB } from "../db/client.js";
import { HashingEmbedder, type Embedder } from "./index.js";
import { createTransformersEmbedder } from "./transformers.js";

export interface EmbedderIdentity {
  name: "hashing" | "transformers";
  dim: number;
  model?: string;
}

const KEY = "embedder";

export const HASHING_IDENTITY: EmbedderIdentity = { name: "hashing", dim: 256 };
export const TRANSFORMERS_IDENTITY: EmbedderIdentity = {
  name: "transformers",
  dim: 384,
  model: "Xenova/all-MiniLM-L6-v2",
};

export function readIdentity(db: DB): EmbedderIdentity | undefined {
  try {
    const row = db
      .prepare(`SELECT value FROM kv WHERE key = @key`)
      .get({ key: KEY }) as { value: string } | undefined;
    if (!row) return undefined;
    const parsed: unknown = JSON.parse(row.value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as EmbedderIdentity).name === "string" &&
      typeof (parsed as EmbedderIdentity).dim === "number"
    ) {
      return parsed as EmbedderIdentity;
    }
  } catch {
    // Unreadable or absent. Treated as unknown below.
  }
  return undefined;
}

export function writeIdentity(db: DB, identity: EmbedderIdentity): void {
  db.prepare(
    `INSERT INTO kv (key, value) VALUES (@key, @value)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run({ key: KEY, value: JSON.stringify(identity) });
}

// What a store was written with. A store with no record predates this and is
// hashed, because that was the only default there has ever been.
export function storeIdentity(db: DB): EmbedderIdentity {
  return readIdentity(db) ?? HASHING_IDENTITY;
}

export interface SelectedEmbedder {
  embedder: Embedder;
  identity: EmbedderIdentity;
  // Set when the store asked for an embedder that could not be built, and a
  // fallback was used instead. Recall will be poor; the caller should say so.
  degraded?: string;
}

// The embedder a store must be read and written with.
//
// REMEM_EMBEDDER=hashing forces the light one, for a machine that cannot afford
// the model or wants no download at all.
export async function selectEmbedder(db: DB): Promise<SelectedEmbedder> {
  const wanted = storeIdentity(db);

  if (process.env.REMEM_EMBEDDER === "hashing" || wanted.name === "hashing") {
    return {
      embedder: new HashingEmbedder({ dim: wanted.dim }),
      identity: wanted,
    };
  }

  try {
    const embedder = await createTransformersEmbedder(
      wanted.model ? { model: wanted.model, dim: wanted.dim } : {},
    );
    return { embedder, identity: wanted };
  } catch (err) {
    // The store holds transformer vectors and we cannot produce more of them.
    // Falling back to hashing would compare incomparable things, so the caller
    // is told rather than quietly given nonsense.
    const message = err instanceof Error ? err.message : String(err);
    return {
      embedder: new HashingEmbedder({ dim: HASHING_IDENTITY.dim }),
      identity: HASHING_IDENTITY,
      degraded:
        `this store was written with ${wanted.name} embeddings, which could not be loaded ` +
        `(${message}). Recall will be poor until it is available, or until the store is ` +
        `re-embedded with: remem-reembed --to hashing`,
    };
  }
}
