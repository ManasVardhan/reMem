import type { Ability } from "./types.js";
import type { EvalReport, SystemMetrics } from "./runner.js";

// Renders an EvalReport as markdown. Deterministic given a report, so the same
// run always produces the same document (the timestamp is the only variable,
// and it is stamped once at the top). No em dashes anywhere by house style.

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function num(value: number, digits = 3): string {
  return value.toFixed(digits);
}

const ABILITY_LABEL: Record<Ability, string> = {
  extraction: "Extraction",
  knowledge_update: "Knowledge update",
  scope: "Scope",
  abstention: "Abstention",
  preference: "Preference following",
};

function overviewTable(systems: SystemMetrics[], k: number): string {
  const header = [
    "System",
    `Recall@${k}`,
    "MRR",
    "Grounded acc",
    "Abstain P",
    "Abstain R",
    "Tokens/query",
    "Latency (ms)",
  ];
  const rows = systems.map((s) => [
    s.system,
    pct(s.recallAtK),
    num(s.mrr),
    pct(s.groundedAccuracy),
    pct(s.abstentionPrecision),
    pct(s.abstentionRecall),
    num(s.avgContextTokens, 1),
    num(s.avgLatencyMs, 2),
  ]);
  return renderTable(header, rows);
}

function abilityTable(systems: SystemMetrics[]): string {
  const orderedAbilities: Ability[] = [];
  for (const s of systems) {
    for (const a of s.byAbility) {
      if (!orderedAbilities.includes(a.ability))
        orderedAbilities.push(a.ability);
    }
  }
  const header = ["System", ...orderedAbilities.map((a) => ABILITY_LABEL[a])];
  const rows = systems.map((s) => {
    const byAbility = new Map(s.byAbility.map((a) => [a.ability, a]));
    return [
      s.system,
      ...orderedAbilities.map((a) => {
        const m = byAbility.get(a);
        return m ? pct(m.groundedAccuracy) : "n/a";
      }),
    ];
  });
  return renderTable(header, rows);
}

function renderTable(header: string[], rows: string[][]): string {
  const head = `| ${header.join(" | ")} |`;
  const sep = `| ${header.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
  return [head, sep, body].join("\n");
}

export function renderReport(report: EvalReport): string {
  const date = new Date(report.generatedTs).toISOString();
  const lines: string[] = [];
  lines.push(`# ReMem evaluation: ${report.dataset}`);
  lines.push("");
  lines.push(`Generated ${date}. Recall cutoff k = ${report.k}.`);
  lines.push("");
  lines.push(
    "Grounded accuracy is the headline number: for answerable cases the " +
      "top-ranked observation must be a current supporting one; for " +
      "unanswerable cases the system must abstain. It rewards surfacing the " +
      "right fact and penalizes both stale answers and confident guesses.",
  );
  lines.push("");
  lines.push("## Overview");
  lines.push("");
  lines.push(overviewTable(report.systems, report.k));
  lines.push("");
  lines.push("## Grounded accuracy by ability");
  lines.push("");
  lines.push(abilityTable(report.systems));
  lines.push("");
  return lines.join("\n");
}
