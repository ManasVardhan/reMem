#!/usr/bin/env node
// SessionStart: inject what memory knows before the model does anything.
//
// This lists beliefs rather than calling recall(). recall() ranks by semantic
// similarity to a query, and at session start there is no query: a broad
// stand-in phrase matches nothing under the default embedder, so everything
// falls below the score floor and the injection comes back empty. Listing the
// most-confident in-scope beliefs is the honest primitive for "what do you
// already know".

import {
  readStdin,
  load,
  survive,
  exitIfInternal,
  kernelRoot,
  bootstrapKernel,
} from "./_shared.mjs";

const MAX_BELIEFS = 12;

exitIfInternal();

// Session start is the one place that can both notice the kernel is missing and
// say so where a person will read it. Every other hook has to stay quiet.
function announceBootstrap(outcome) {
  const message =
    outcome === "unavailable"
      ? "reMem is installed but its kernel is missing, and it could not fetch one. Run `npx remem-kernel setup` to finish the install."
      : "reMem is fetching its kernel in the background, including a local embedding model, so expect a few hundred MB and a few minutes. Nothing leaves this machine. Memory starts recording from your next session.";
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `## reMem\n\n${message}`,
      },
    }),
  );
  process.exit(0);
}

try {
  if (!kernelRoot()) announceBootstrap(bootstrapKernel());

  const payload = await readStdin();
  const { openMatchedKernel, projectScope } = await load("mcp/store.js");
  const { inScopeByConfidence } = await load("mcp/scope.js");

  const { kernel } = await openMatchedKernel();
  const project = projectScope(payload.cwd);

  const inScope = inScopeByConfidence(
    kernel.effectiveBeliefs({ status: "active" }),
    project,
    MAX_BELIEFS,
  );

  if (inScope.length === 0) process.exit(0);

  const lines = inScope.map(
    (b) =>
      `- ${b.predicate}: ${b.value}  (${b.effectiveConfidence.toFixed(2)}, id ${b.id})`,
  );

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `## reMem\n\nWhat memory holds about this user and project:\n\n${lines.join("\n")}\n\nCall why(belief_id) for the observations behind any of these, and recall(query) to search further.`,
      },
    }),
  );
} catch (err) {
  survive(err);
}
