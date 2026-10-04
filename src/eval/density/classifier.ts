import type { ChatCompleter } from "../../consolidate/llm.js";
import type { DensityLabel, DensityQuestion, DensityVerdict } from "./types.js";

export const DENSITY_SYSTEM_PROMPT = `You decide whether answering a specific QUESTION requires resolving a CONTRADICTION in the provided context.

This is a narrow test. Answer "contradiction" only when ALL of the following hold:
1. The context contains two assertions about the SAME entity and the SAME property.
2. They give different, incompatible values for that property.
3. The QUESTION asks about exactly that entity and that property.
4. The GOLD ANSWER is the value from the LATER assertion, so the earlier one has been superseded.

If a reader could answer the question correctly from a single assertion, without having to decide which of two competing values is current, the answer is "no-contradiction".

The following are NOT contradictions:
- A sequence of events over time. "Lost my job" followed by "started a business" is a story, not a conflict.
- Different instances of the same kind of event. "Won my second tournament" and "won my fourth tournament" are two events, not two values of one property.
- Elaboration or added detail. "Got a new car" followed by "got a new Ferrari" is one fact stated twice.
- Two statements that are simply both true, or that have nothing to do with each other.
- Anything not about the entity and property the QUESTION asks about.

Quote the two conflicting assertions verbatim from the context. The GOLD ANSWER must appear in the second quote.

Respond with strict JSON and nothing else:
{"label":"contradiction","evidence":["earlier assertion verbatim","later assertion verbatim, containing the gold answer"]}
or
{"label":"no-contradiction","evidence":[]}`;

// Strip a markdown fence if the model wrapped its JSON in one. Cheap, and it
// turns a class of parse failures into successes without loosening the schema.
function unfence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/, "")
    .trim();
}

// Parse a model reply into a verdict. A "contradiction" claim with fewer than
// two quoted assertions is downgraded, because the evidence pair is the only
// thing separating a real finding from a guess. Malformed output is
// no-contradiction: the conservative direction, since the paper's argument is
// that density is LOW and an error that inflates it would flatter the thesis.
export function parseVerdict(raw: string, id: string): DensityVerdict {
  let label: DensityLabel = "no-contradiction";
  let evidence: string[] = [];
  try {
    const parsed = JSON.parse(unfence(raw)) as {
      label?: unknown;
      evidence?: unknown;
    };
    const claimed = parsed.label === "contradiction";
    const items = Array.isArray(parsed.evidence)
      ? parsed.evidence.filter((e): e is string => typeof e === "string")
      : [];
    if (claimed && items.length >= 2) {
      label = "contradiction";
      evidence = items.slice(0, 2);
    }
  } catch {
    // fall through to the conservative default
  }
  return { id, label, evidence, failed: false };
}

function renderQuestion(q: DensityQuestion): string {
  const lines = q.context.map((c, i) => `[${i + 1}] ${c}`).join("\n");
  return `QUESTION: ${q.question}\nGOLD ANSWER: ${q.goldAnswer}\n\nCONTEXT:\n${lines}`;
}

// The model is asked to put the winning value in its second quote. Checking that
// in code turns a claim into something verifiable, and it rejects the failure
// mode seen on real data, where two unrelated sentences were quoted as though
// they conflicted. Comparison is case insensitive and ignores surrounding
// whitespace, because quotes are lifted verbatim from conversational text.
function goldAppearsInLaterQuote(verdict: DensityVerdict, goldAnswer: string): boolean {
  const gold = goldAnswer.trim().toLowerCase();
  if (gold === "") return false;
  const later = (verdict.evidence[1] ?? "").toLowerCase();
  return later.includes(gold);
}

export async function classifyQuestion(
  complete: ChatCompleter,
  q: DensityQuestion,
): Promise<DensityVerdict> {
  const raw = await complete([
    { role: "system", content: DENSITY_SYSTEM_PROMPT },
    { role: "user", content: renderQuestion(q) },
  ]);
  const verdict = parseVerdict(raw, q.id);
  if (verdict.label === "contradiction" && !goldAppearsInLaterQuote(verdict, q.goldAnswer)) {
    return { id: q.id, label: "no-contradiction", evidence: [], failed: false };
  }
  return verdict;
}

// Sequential on purpose. The whole sweep is roughly 2,000 short calls, which is
// minutes, and a failed call must not lose its place in the output ordering.
export async function classifyAll(
  complete: ChatCompleter,
  questions: DensityQuestion[],
): Promise<DensityVerdict[]> {
  const out: DensityVerdict[] = [];
  for (const q of questions) {
    try {
      out.push(await classifyQuestion(complete, q));
    } catch {
      out.push({ id: q.id, label: "no-contradiction", evidence: [], failed: true });
    }
  }
  return out;
}
