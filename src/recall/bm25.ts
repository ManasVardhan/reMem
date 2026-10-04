// A small, dependency-free BM25 ranking function over an in-memory candidate
// set. The design (DESIGN.md 4.4) calls for BM25 via SQLite FTS5; that native
// path arrives with the sqlite-vec/FTS5 integration. Until then this stands in
// the same way HashingEmbedder stands in for a local Transformers.js model: a
// real, deterministic implementation that keeps recall testable and offline.
//
// BM25 is computed over the candidate documents actually under consideration,
// not the whole store. Recall first narrows to scope-compatible candidates, so
// scoring the local corpus keeps idf meaningful for the retrieval at hand.

const K1 = 1.5;
const B = 0.75;

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

export interface Bm25Doc {
  id: string;
  text: string;
}

// Precomputed index over a candidate corpus. Cheap to build per-recall because
// the candidate set is small (post scope-filter), not the entire ledger.
export class Bm25Index {
  private readonly docTokens = new Map<string, string[]>();
  private readonly docLen = new Map<string, number>();
  // term -> number of docs containing it.
  private readonly df = new Map<string, number>();
  private avgdl = 0;
  private readonly n: number;

  constructor(docs: Bm25Doc[]) {
    this.n = docs.length;
    let totalLen = 0;
    for (const doc of docs) {
      const tokens = tokenize(doc.text);
      this.docTokens.set(doc.id, tokens);
      this.docLen.set(doc.id, tokens.length);
      totalLen += tokens.length;
      for (const term of new Set(tokens)) {
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }
    }
    this.avgdl = this.n > 0 ? totalLen / this.n : 0;
  }

  private idf(term: string): number {
    const n = this.df.get(term) ?? 0;
    // Standard BM25 idf with the +1 smoothing that keeps it non-negative.
    return Math.log(1 + (this.n - n + 0.5) / (n + 0.5));
  }

  // Raw BM25 score of one document against the query. Higher is more relevant;
  // 0 means no query term occurs in the document.
  score(docId: string, queryTerms: string[]): number {
    const tokens = this.docTokens.get(docId);
    if (!tokens || tokens.length === 0) return 0;
    const dl = this.docLen.get(docId) ?? 0;
    const freq = new Map<string, number>();
    for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);

    let score = 0;
    for (const term of queryTerms) {
      const f = freq.get(term);
      if (!f) continue;
      const denom = f + K1 * (1 - B + (B * dl) / (this.avgdl || 1));
      score += this.idf(term) * ((f * (K1 + 1)) / denom);
    }
    return score;
  }

  // Score every document, returned as a map. Convenience for recall, which
  // max-normalizes these before blending with vector similarity.
  scoreAll(query: string): Map<string, number> {
    const queryTerms = tokenize(query);
    const out = new Map<string, number>();
    for (const id of this.docTokens.keys()) {
      out.set(id, this.score(id, queryTerms));
    }
    return out;
  }
}
