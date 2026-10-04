#!/usr/bin/env node
// SessionEnd: turn the session's observations into beliefs, once.
//
// Batched deliberately. Consolidation runs a model over the observation window
// and is the expensive half of the kernel, so it must not sit in the prompt
// path or fire per tool call. Registered async so it never delays teardown.

import { readStdin, load, survive, exitIfInternal } from "./_shared.mjs";

exitIfInternal();

try {
  const payload = await readStdin();
  const { LLMConsolidator } = await load("index.js");
  const { openMatchedKernel } = await load("mcp/store.js");
  const { selectCompleter } = await load("consolidate/select.js");

  const { source, complete } = await selectCompleter();
  if (!complete) {
    // A normal outcome, not a failure. The ledger keeps the observations and a
    // later session with a provider configured will fold them in.
    process.stderr.write(
      "reMem: no consolidator provider available. Observations remain in the ledger.\n",
    );
    process.exit(0);
  }

  const { kernel } = await openMatchedKernel(new LLMConsolidator({ complete }));

  const sessionId = payload.session_id ?? payload.sessionId;

  // Scope the pass to this session when we know it. Consolidating the whole
  // ledger at every session end is what makes a memory system get slower the
  // longer you use it.
  const report = await kernel.consolidate(sessionId ? { sessionId } : {});

  // The readable account of the session, written once here rather than on
  // every tool call. Failure to produce one is not failure to remember: the
  // ledger and the beliefs are already written.
  let episode = "";
  if (sessionId) {
    try {
      const { deriveEpisode } = await load("consolidate/episode.js");
      const record = await deriveEpisode(kernel.raw, { sessionId, complete });
      if (record) episode = `, wrote "${record.title.slice(0, 60)}"`;
    } catch {
      episode = "";
    }
    kernel.closeSession(sessionId);
  }
  kernel.close();

  process.stderr.write(
    `reMem: consolidated via ${source} (created ${report.created}, contradicted ${report.contradicted}, reinforced ${report.reinforced}${episode}).\n`,
  );
} catch (err) {
  survive(err);
}
