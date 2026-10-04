import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HashingEmbedder } from "../embed/index.js";
import { createTransformersEmbedder } from "../embed/transformers.js";
import type { Embedder } from "../embed/index.js";
import type { Consolidator } from "../consolidate/consolidator.js";
import { LLMConsolidator, createOpenAICompleter } from "../consolidate/llm.js";
import type { ChatCompleter } from "../consolidate/llm.js";
import {
  loadPrefEvalSamples,
  type PrefForm,
  type PrefEvalSample,
  PREF_CONSOLIDATOR_INSTRUCTIONS,
} from "./prefeval.js";
import { NaiveVectorSystem } from "./systems.js";
import { PrecomputedSystem, buildReMemRetrievals } from "./shared-store.js";
import { beliefToSentence } from "./pref-judge.js";
import type { MemorySystem } from "./types.js";

// DIAGNOSTIC (throwaway): trace the PrefEval follow-rate disconnect. Aggregate
// runs show reMem grounds better than naive yet does not win follow rate; it
// even violates MORE. This script dumps, per case, the ground-truth preference,
// the consolidated belief handed to the answerer, whether the gold turn was in
// reMem's top-k, the generated answer, and the judge label, for BOTH naive and
// reMem. Then it flags the cases where reMem grounded but did not follow, and
// where reMem violated while naive followed (belief actively hurt), so we can
// read whether the belief text is wrong, or a correct belief is misapplied.

// Prompts copied verbatim from pref-judge.ts so labels match the real harness.
const ANSWERER_SYSTEM = `You are a helpful personal assistant continuing a long conversation with a user. You are given memory snippets recalled from earlier in that conversation, then the user's new question.

Rules:
- Answer the question helpfully and specifically, as you normally would.
- Take the recalled memory snippets into account. They may reveal standing preferences, constraints, or context about the user.
- Do not invent details about the user that are not supported by the snippets.
- Keep it to a short, concrete recommendation (a few sentences).

Respond with strict JSON: {"answer": "your response"}.`;

const JUDGE_SYSTEM = `You are grading whether an assistant's answer respects a user's standing preference.

You are given the user's PREFERENCE (ground truth), the QUESTION they asked, and the assistant's ANSWER. Classify the answer:
- "follows": the answer is consistent with the preference (it recommends or does what the preference implies, and avoids what the preference rules out).
- "violates": the answer recommends or endorses something the preference rules out, or ignores a constraint the preference sets.
- "unaware": the answer neither respects nor contradicts the preference in a way tied to it; it simply does not reflect any awareness of the preference (generic answer).
- "hallucinate": the answer invents a different or contradictory preference/constraint not stated by the user.

Only "follows" counts as success. Respond with strict JSON: {"label": "follows"|"violates"|"unaware"|"hallucinate"}.`;

const LABELS = ["follows", "violates", "unaware", "hallucinate"] as const;
type PrefLabel = (typeof LABELS)[number];

function contextSnippets(
  sample: PrefEvalSample,
  ids: string[],
  k: number,
  beliefs: string[],
): string {
  const byId = new Map(
    sample.cases[0]?.observations.map((o) => [o.id, o.content]) ?? [],
  );
  const parts: string[] = [];
  if (beliefs.length > 0) {
    parts.push(
      "Known about the user:\n" +
        beliefs.map((b) => `- ${beliefToSentence(b)}`).join("\n"),
    );
  }
  const turns: string[] = [];
  for (const id of ids.slice(0, k)) {
    const text = byId.get(id);
    if (text) turns.push(`- ${text}`);
  }
  if (turns.length > 0) parts.push("Recent conversation turns:\n" + turns.join("\n"));
  return parts.length > 0 ? parts.join("\n\n") : "(no memory retrieved)";
}

function parseAnswer(raw: string): string {
  try {
    const parsed = JSON.parse(raw.trim()) as { answer?: unknown };
    if (typeof parsed.answer === "string") return parsed.answer.trim();
  } catch {
    /* fall through */
  }
  return raw.trim();
}

function parseLabel(raw: string): PrefLabel {
  try {
    const parsed = JSON.parse(raw.trim()) as { label?: unknown };
    if (typeof parsed.label === "string" && (LABELS as readonly string[]).includes(parsed.label)) {
      return parsed.label as PrefLabel;
    }
  } catch {
    /* fall through */
  }
  for (const label of LABELS) {
    if (new RegExp(`"label"\\s*:\\s*"${label}"`, "i").test(raw)) return label;
  }
  return "unaware";
}

async function answer(complete: ChatCompleter, question: string, snippets: string): Promise<string> {
  const raw = await complete([
    { role: "system", content: ANSWERER_SYSTEM },
    {
      role: "user",
      content: `MEMORY SNIPPETS:\n${snippets}\n\nUSER QUESTION: ${question}\n\nRespond with {"answer": "..."}.`,
    },
  ]);
  return parseAnswer(raw);
}

async function judge(
  complete: ChatCompleter,
  preference: string,
  question: string,
  ans: string,
): Promise<PrefLabel> {
  const raw = await complete([
    { role: "system", content: JUDGE_SYSTEM },
    {
      role: "user",
      content: `PREFERENCE: ${preference}\nQUESTION: ${question}\nANSWER: ${ans}\n\nRespond with {"label": "follows"|"violates"|"unaware"|"hallucinate"}.`,
    },
  ]);
  return parseLabel(raw);
}

interface CaseRecord {
  sampleId: string;
  preference: string;
  question: string;
  beliefText: string[];
  goldContent: string[];
  reMemGrounded: boolean;
  naiveGrounded: boolean;
  reMemAnswer: string;
  reMemLabel: PrefLabel;
  naiveAnswer: string;
  naiveLabel: PrefLabel;
}

function parseArgs(argv: string[]) {
  const o = { form: "choice-based" as PrefForm, turns: 50, instances: 40, hashing: false, batch: 8, k: 5, minScore: 0.3 };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "form" && value) o.form = value as PrefForm;
    else if (key === "turns" && value) o.turns = Number(value);
    else if (key === "instances" && value) o.instances = Number(value);
    else if (key === "hashing") o.hashing = true;
    else if (key === "batch" && value) o.batch = Number(value);
    else if (key === "k" && value) o.k = Number(value);
    else if (key === "minScore" && value) o.minScore = Number(value);
  }
  return o;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Needs OPENAI_API_KEY (answerer + judge + belief consolidation).");
  }
  const base: Embedder = opts.hashing ? new HashingEmbedder() : createTransformersEmbedder();
  const cache = new Map<string, Float32Array>();
  const embedder: Embedder = {
    dim: base.dim,
    async embed(t: string) {
      const hit = cache.get(t);
      if (hit) return hit;
      const v = await base.embed(t);
      cache.set(t, v);
      return v;
    },
  };

  const samples = loadPrefEvalSamples({ form: opts.form, distractorTurns: opts.turns, maxInstances: opts.instances });
  process.stdout.write(`Loaded ${samples.length} ${opts.form} instances, ${opts.turns} distractors\n`);

  const reMemRecall = opts.hashing ? { alpha: 1, minScore: opts.minScore } : { minScore: opts.minScore };
  const makeConsolidator: () => Consolidator = () =>
    new LLMConsolidator({
      complete: createOpenAICompleter(),
      extraInstructions: PREF_CONSOLIDATOR_INSTRUCTIONS,
    });

  const beliefTextByCaseId = new Map<string, string[]>();
  process.stdout.write("Building reMem belief stores...\n");
  const reMemRetrievals = await buildReMemRetrievals(samples, {
    embedder,
    makeConsolidator,
    recallOptions: reMemRecall,
    consolidateEvery: opts.batch,
    rankModes: ["blended"],
    onCaseBeliefs: (caseId, statements) => beliefTextByCaseId.set(caseId, statements),
    onSampleDone: (id, i, n) => {
      if (i === n || i % 10 === 0) process.stdout.write(`  built ${i}/${n}\n`);
    },
  });

  const reMem: MemorySystem = new PrecomputedSystem("reMem", reMemRetrievals.get("blended")!);
  const naive: MemorySystem = new NaiveVectorSystem(embedder);
  const answerer = createOpenAICompleter();
  const judgeC = createOpenAICompleter();

  const records: CaseRecord[] = [];
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]!;
    const c = sample.cases[0]!;
    const goldIds = new Set(c.goldObservationIds ?? []);
    const goldContent = c.observations.filter((o) => goldIds.has(o.id)).map((o) => o.content);

    const eRet = await reMem.retrieve(c);
    const nRet = await naive.retrieve(c);
    const eTop = eRet.rankedObservationIds.slice(0, opts.k);
    const nTop = nRet.rankedObservationIds.slice(0, opts.k);
    const beliefs = beliefTextByCaseId.get(c.id) ?? [];

    const eSnip = contextSnippets(sample, eRet.rankedObservationIds, opts.k, beliefs);
    const nSnip = contextSnippets(sample, nRet.rankedObservationIds, opts.k, []);
    const eAns = await answer(answerer, c.query, eSnip);
    const nAns = await answer(answerer, c.query, nSnip);
    const eLbl = await judge(judgeC, sample.preference, c.query, eAns);
    const nLbl = await judge(judgeC, sample.preference, c.query, nAns);

    records.push({
      sampleId: sample.sampleId,
      preference: sample.preference,
      question: c.query,
      beliefText: beliefs,
      goldContent,
      reMemGrounded: [...goldIds].some((id) => eTop.includes(id)),
      naiveGrounded: [...goldIds].some((id) => nTop.includes(id)),
      reMemAnswer: eAns,
      reMemLabel: eLbl,
      naiveAnswer: nAns,
      naiveLabel: nLbl,
    });
    if ((i + 1) % 10 === 0) process.stdout.write(`  judged ${i + 1}/${samples.length}\n`);
  }

  const date = new Date().toISOString().slice(0, 10);
  const outDir = join(process.cwd(), "eval", "results", `diag-followrate-${opts.form}-${date}-t${opts.turns}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "records.json"), JSON.stringify(records, null, 2), "utf8");

  const groundedNotFollow = records.filter((r) => r.reMemGrounded && r.reMemLabel !== "follows");
  const beliefHurt = records.filter((r) => r.reMemLabel === "violates" && r.naiveLabel === "follows");
  const beliefHelped = records.filter((r) => r.naiveLabel !== "follows" && r.reMemLabel === "follows");

  const lines: string[] = [];
  lines.push(`# Follow-rate diagnosis: ${opts.form}, t${opts.turns}, ${records.length} cases\n`);
  const eFollow = records.filter((r) => r.reMemLabel === "follows").length;
  const nFollow = records.filter((r) => r.naiveLabel === "follows").length;
  lines.push(`reMem follows ${eFollow}/${records.length}, naive follows ${nFollow}/${records.length}`);
  lines.push(`reMem grounded ${records.filter((r) => r.reMemGrounded).length}, naive grounded ${records.filter((r) => r.naiveGrounded).length}`);
  lines.push(`belief HELPED (naive miss -> reMem follow): ${beliefHelped.length}`);
  lines.push(`belief HURT (reMem violate & naive follow): ${beliefHurt.length}`);
  lines.push(`reMem grounded but NOT follow: ${groundedNotFollow.length}\n`);

  const dump = (title: string, rs: CaseRecord[]) => {
    lines.push(`\n## ${title} (${rs.length})\n`);
    for (const r of rs.slice(0, 15)) {
      lines.push(`### ${r.sampleId} [reMem=${r.reMemLabel} naive=${r.naiveLabel} grounded=${r.reMemGrounded}]`);
      lines.push(`- PREFERENCE: ${r.preference}`);
      lines.push(`- GOLD TURN: ${r.goldContent.join(" | ")}`);
      lines.push(`- BELIEF: ${r.beliefText.length ? r.beliefText.map((b) => `"${b}"`).join("; ") : "(none)"}`);
      lines.push(`- REMEM ANSWER: ${r.reMemAnswer}`);
      lines.push(`- NAIVE ANSWER: ${r.naiveAnswer}\n`);
    }
  };
  dump("BELIEF HURT", beliefHurt);
  dump("REMEM GROUNDED BUT NOT FOLLOW", groundedNotFollow);

  const report = lines.join("\n") + "\n";
  writeFileSync(join(outDir, "diagnosis.md"), report, "utf8");
  process.stdout.write("\n" + report);
  process.stdout.write(`\nWrote ${records.length} records + diagnosis to ${outDir}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
