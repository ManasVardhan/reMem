// Re-embedding a store.
//
// Every observation and belief carries the vector it was written with. Changing
// embedder means every one of them has to be recomputed, because a query vector
// from a different embedder cannot be compared to them: the comparison does not
// fail, it just returns noise.
//
// Observations are append-only and their triggers say so. This is the same
// privileged path an erasure takes, and it is legitimate here for the same
// reason: the row's content, timestamp and provenance are untouched, only the
// index built over it is rebuilt. Nothing about what was said changes.

import type { DB } from "../db/client.js";
import type { Embedder } from "./index.js";
import { embeddingToBlob } from "../db/serde.js";
import { writeIdentity, type EmbedderIdentity } from "./select.js";

export interface ReembedReport {
  observations: number;
  beliefs: number;
  entities: number;
  identity: EmbedderIdentity;
}

export interface ReembedOptions {
  onProgress?: (done: number, total: number) => void;
  batchSize?: number;
}

const APPEND_ONLY_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS observation_no_update
BEFORE UPDATE ON observation
BEGIN
  SELECT RAISE(ABORT, 'observation is append-only');
END;
CREATE TRIGGER IF NOT EXISTS observation_no_delete
BEFORE DELETE ON observation
BEGIN
  SELECT RAISE(ABORT, 'observation is append-only');
END;
`;

export async function reembed(
  db: DB,
  embedder: Embedder,
  identity: EmbedderIdentity,
  options: ReembedOptions = {},
): Promise<ReembedReport> {
  const report: ReembedReport = {
    observations: 0,
    beliefs: 0,
    entities: 0,
    identity,
  };

  const rows = db
    .prepare(`SELECT id, content FROM observation ORDER BY rowid`)
    .all() as Array<{ id: string; content: string }>;
  const beliefs = db
    .prepare(`SELECT id, predicate, value FROM belief`)
    .all() as Array<{ id: string; predicate: string; value: string }>;
  const entities = db.prepare(`SELECT id, name FROM entity`).all() as Array<{
    id: string;
    name: string;
  }>;

  const total = rows.length + beliefs.length + entities.length;
  let done = 0;

  // Embedding happens outside the transaction: it is the slow part, and holding
  // a write lock across it would block every hook for the length of the run.
  const observationVectors = new Map<string, Buffer>();
  for (const row of rows) {
    observationVectors.set(
      row.id,
      embeddingToBlob(await embedder.embed(row.content)),
    );
    done += 1;
    if (done % 100 === 0) options.onProgress?.(done, total);
  }

  const beliefVectors = new Map<string, Buffer>();
  for (const belief of beliefs) {
    beliefVectors.set(
      belief.id,
      embeddingToBlob(
        await embedder.embed(`${belief.predicate} ${belief.value}`),
      ),
    );
    done += 1;
  }

  const entityVectors = new Map<string, Buffer>();
  for (const entity of entities) {
    entityVectors.set(
      entity.id,
      embeddingToBlob(await embedder.embed(entity.name)),
    );
    done += 1;
  }
  options.onProgress?.(done, total);

  const write = db.transaction(() => {
    db.exec(`DROP TRIGGER IF EXISTS observation_no_update`);
    db.exec(`DROP TRIGGER IF EXISTS observation_no_delete`);

    const setObservation = db.prepare(
      `UPDATE observation SET embedding = @embedding WHERE id = @id`,
    );
    for (const [id, embedding] of observationVectors) {
      setObservation.run({ id, embedding });
      report.observations += 1;
    }

    const setBelief = db.prepare(
      `UPDATE belief SET embedding = @embedding WHERE id = @id`,
    );
    for (const [id, embedding] of beliefVectors) {
      setBelief.run({ id, embedding });
      report.beliefs += 1;
    }

    const setEntity = db.prepare(
      `UPDATE entity SET embedding = @embedding WHERE id = @id`,
    );
    for (const [id, embedding] of entityVectors) {
      setEntity.run({ id, embedding });
      report.entities += 1;
    }

    writeIdentity(db, identity);

    // Back on before anything else can touch the table.
    db.exec(APPEND_ONLY_TRIGGERS);
  });
  write();

  return report;
}
