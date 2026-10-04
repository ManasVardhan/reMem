// Scope filtering for the session-start read.
//
// Extracted so the rule that decides what a session may see is testable, rather
// than living only inside a hook script.

export interface ScopedBelief {
  scope?: { project?: string } & Record<string, unknown>;
  effectiveConfidence: number;
}

// A belief with no project dimension holds anywhere. A belief carrying a
// different project belongs to another repo and must not leak into this
// session. Highest confidence first, capped.
export function inScopeByConfidence<T extends ScopedBelief>(
  beliefs: T[],
  project: string | undefined,
  limit: number,
): T[] {
  return beliefs
    .filter((b) => {
      const scoped = b.scope?.project;
      return scoped === undefined || scoped === project;
    })
    .sort((a, b) => b.effectiveConfidence - a.effectiveConfidence)
    .slice(0, limit);
}
