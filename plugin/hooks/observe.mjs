#!/usr/bin/env node
// UserPromptSubmit: record what the user said, and hand back what memory knows
// about it.
//
// Both halves are LLM-free, which is what lets them sit in the prompt path.
// observe() appends to the ledger; recall() ranks the belief layer against the
// prompt using embeddings and BM25 and costs nothing per message.
//
// The recall half matters more than it looks. Injecting at session start alone
// means memory is whatever was relevant before the conversation had a subject:
// everything after that depends on the model choosing to call a tool. This
// makes the relevant part of memory present on the turn it becomes relevant,
// without anything having to decide to go looking.
//
// It abstains rather than guessing. Nothing above the score floor means nothing
// is injected, which is a real answer and keeps the prompt clean.

import {
  readStdin,
  load,
  survive,
  exitIfInternal,
  viewerClaim,
} from "./_shared.mjs";

// A ceiling on what gets prepended to every prompt. Memory that crowds out the
// conversation it is meant to serve is a cost, not a feature.
const MAX_RECALL_CHARS = 1400;
const MAX_INJECTED_BELIEFS = 6;
const RECALL_CANDIDATES = 60;

// How much of the score comes from keywords rather than meaning. The default
// splits it evenly, which is right when the vectors are hashes and carry no
// meaning to weigh. With a sentence model they do, and leaning on it is what
// lets "when do I finish university" find a belief called graduation_date.
const SEMANTIC_ALPHA = 0.2;

// A score high enough to stand on its own without a shared word.
//
// Tuned by hand against one store, and worth stating plainly: scores are not
// comparable across queries, so no single number separates a real hit from a
// miss. Measured there, "what is the capital of France" scored 0.190 while a
// genuine hit on highlights scored 0.189. Absolute thresholds cannot tell
// those apart, and neither can the gap to the runner-up.
//
// What does work is that the two tests fail in different places. A paraphrase
// with no shared word scores well above this; an unrelated question scores
// below it and shares no word either. Either signal admits a belief, so each
// covers the other's blind spot.
const STRONG_MATCH = 0.35;

// Ask the viewer to recall, if one is running.
//
// A sentence model costs about a second to load and two milliseconds to run,
// and every hook is a fresh process, so loading one here means paying that
// second on every prompt. The viewer is already running, already has the store
// open, and already holds a warm model. Asking it is the difference between a
// second of latency per prompt and a fifth of one.
//
// Returns undefined for any reason at all, and the caller falls back to doing
// the work itself. This is an optimisation; it must never be a dependency.
// Only a viewer serving this hook's own store will do. See viewerClaim.
function viewerPort() {
  return viewerClaim()?.port;
}

// An embedder that asks the viewer for the one vector this hook needs.
//
// Recording an observation embeds its text, so without this the hook loads a
// sentence model to embed a single sentence and then throws it away. The
// viewer already holds a warm one.
//
// Returns undefined when there is no viewer, and the caller falls back to
// loading its own. Always an optimisation, never a dependency.
async function embedderViaViewer() {
  const port = viewerPort();
  if (!port) return undefined;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const probe = await fetch(`http://127.0.0.1:${port}/api/embed?text=probe`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!probe.ok) return undefined;
    const body = await probe.json();
    if (!Array.isArray(body?.vector)) return undefined;

    return {
      dim: body.dim,
      async embed(text) {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/embed?text=${encodeURIComponent(text)}`,
        );
        if (!res.ok) throw new Error(`viewer embed failed: ${res.status}`);
        const out = await res.json();
        return Float32Array.from(out.vector);
      },
    };
  } catch {
    return undefined;
  }
}

async function recallViaViewer(query, project) {
  try {
    const claim = viewerClaim();
    if (!claim?.port) return undefined;

    const url =
      `http://127.0.0.1:${claim.port}/api/recall?q=${encodeURIComponent(query)}` +
      (project ? `&project=${encodeURIComponent(project)}` : "") +
      `&topK=${RECALL_CANDIDATES}&alpha=${SEMANTIC_ALPHA}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return undefined;

    const body = await res.json();
    return Array.isArray(body?.beliefs) ? body : undefined;
  } catch {
    // No viewer, no claim file, a timeout, a stale port. All the same answer.
    return undefined;
  }
}

// Words too common to be evidence that a belief bears on a prompt.
const STOPWORDS = new Set(
  (
    "the a an of to in on at for and or but is are was were be been do does did " +
    "how what which why when who where i me my mine you your it its this that " +
    "with from can could should would will just about into over under not no " +
    "yes we us our they them their he she his her if then than so as by"
  ).split(" "),
);

function contentWords(text) {
  // Underscores and hyphens separate words rather than belonging to them.
  // Predicates are snake_case, so keeping them joined meant asking for a
  // graduation date never matched the belief named graduation_date.
  const found = text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? [];
  return new Set(found.filter((w) => !STOPWORDS.has(w)));
}

// Does this belief share any real word with the prompt?
//
// The default embedder is a hashing trick with no semantic signal, so recall's
// ranking on a paraphrase falls back to confidence and recency: asked about
// the capital of France it will happily return the user's work authorisation.
// That is fine for a tool the model chooses to call and checks the answer of.
// It is not fine for something prepended to every prompt, where the cost of a
// wrong hit is paid on every turn and nobody asked for it.
//
// Requiring a shared word trades recall for precision. It misses paraphrases,
// which is a real loss; it also stays quiet rather than filling the prompt
// with confident irrelevance, which matters more when the alternative is
// silence. Replace this the day the store is embedded semantically.
function bearsOn(promptWords, belief) {
  const words = contentWords(`${belief.predicate} ${belief.value}`);
  for (const word of promptWords) {
    if (words.has(word)) return true;
  }
  return false;
}

exitIfInternal();

try {
  const payload = await readStdin();
  const raw = (payload.prompt ?? "").trim();
  if (!raw) process.exit(0);

  const { openMatchedKernel, openKernelWith } = await load("mcp/store.js");
  const { userAuthored } = await load("index.js");

  // The prompt channel carries more than prompts: task notifications, system
  // reminders, the output of a slash command. The kernel refuses to record
  // them; a hook should not make that an error, it should just say nothing.
  const content = userAuthored(raw);
  if (!content) process.exit(0);
  const { projectScope, projectPath } = await load("mcp/store.js");

  // Matched to the store's own embedder. A kernel built with the default one
  // against a store written by another compares incomparable vectors and
  // returns confident noise.
  // The viewer's warm model if it is up, this process's own if not.
  const remote = await embedderViaViewer();
  const { kernel, identity } = remote
    ? await openKernelWith(remote)
    : await openMatchedKernel();
  const semantic = identity.name === "transformers";
  const project = projectScope(payload.cwd);
  const path = projectPath(payload.cwd);
  const sessionId = payload.session_id ?? payload.sessionId;

  // The session row is opened here rather than at SessionStart, because
  // SessionStart does not fire for every way a session can begin (a resume, a
  // compact) and the first prompt always does.
  let turn = 0;
  if (sessionId) {
    kernel.session({
      id: sessionId,
      source: "claude-code",
      ...(project ? { project } : {}),
      title: content.slice(0, 120),
      ...(path ? { meta: { path } } : {}),
    });
    turn = kernel.countPrompt(sessionId);
  }

  // What memory holds that bears on this prompt, asked before the prompt is
  // recorded. The other way round, recall retrieves the observation written a
  // millisecond earlier and hands the model back its own words as though they
  // were something remembered.
  //
  // Off with REMEM_RECALL=off, for anyone who would rather ask for memory than
  // be given it.
  if (process.env.REMEM_RECALL !== "off") {
    try {
      // The running viewer first, because it already has a warm model. Doing
      // it here is correct but costs a model load on every single prompt.
      const pack =
        (await recallViaViewer(content, project)) ??
        (await kernel.recall(content, project ? { project } : {}, {
          maxChars: MAX_RECALL_CHARS,
          ...(semantic ? { alpha: SEMANTIC_ALPHA } : {}),
          // A wide net, narrowed below. The gate can only filter what recall
          // returned, so a small top-K means the belief that actually bears on
          // the prompt is often never a candidate in the first place.
          topKBeliefs: RECALL_CANDIDATES,
        }));

      // A belief earns its place by sharing a word with the prompt, or by
      // matching its meaning strongly enough to need no shared word. Without
      // either test the ranking falls back to confidence and recency, and
      // every turn gets the same few beliefs whatever it was about.
      const promptWords = contentWords(content);
      const relevant = pack.beliefs.filter(
        (b) =>
          bearsOn(promptWords, b) ||
          (semantic && typeof b.score === "number" && b.score >= STRONG_MATCH),
      );

      if (!pack.abstained && relevant.length > 0) {
        const lines = relevant
          .slice(0, MAX_INJECTED_BELIEFS)
          .map(
            (b) =>
              `- ${b.predicate}: ${b.value} (confidence ${b.confidence.toFixed(2)}, id ${b.id})`,
          );

        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "UserPromptSubmit",
              additionalContext:
                `## What reMem holds that bears on this\n\n${lines.join("\n")}\n\n` +
                `Call why(belief_id) for the observations behind any of them. ` +
                `Say so if one of these looks wrong.`,
            },
          }),
        );
      }
    } catch {
      // Recall is an enhancement to the turn, not a precondition for it. A
      // failure here must not cost the user their prompt, and must not stop
      // the observation above from having been recorded.
    }
  }

  await kernel.observe({
    source: "code",
    actor: "user",
    content,
    contextSnapshot: {
      surface: "claude-code",
      ...(project ? { project, projectName: project } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(turn ? { promptNumber: turn } : {}),
    },
  });

  kernel.close();
} catch (err) {
  survive(err);
}
