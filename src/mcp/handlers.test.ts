import { describe, it, expect, beforeEach } from "vitest";
import { ReMemKernel } from "../kernel.js";
import { FunctionConsolidator } from "../consolidate/consolidator.js";
import type { BeliefOp } from "../consolidate/ops.js";
import { handleTool, NO_MEMORY } from "./handlers.js";

// A consolidator that turns "prefers X" into a belief and supersedes a prior
// one. Scripted so these tests stay hermetic: no model, no network.
function scripted() {
  return new FunctionConsolidator(async (ctx): Promise<BeliefOp[]> => {
    const ops: BeliefOp[] = [];
    for (const o of ctx.observations) {
      const m = /prefers (\w+)/i.exec(o.content);
      if (!m) continue;
      const value = m[1]!;
      const prior = ctx.relevantBeliefs.find(
        (b) => b.predicate === "editor" && b.status === "active",
      );
      if (prior && prior.value !== value) {
        ops.push({
          op: "CONTRADICT",
          beliefId: prior.id,
          newValue: value,
          confidence: 0.9,
          evidence: [o.id],
        });
      } else if (!prior) {
        ops.push({
          op: "CREATE",
          kind: "preference",
          predicate: "editor",
          value,
          confidence: 0.95,
          evidence: [o.id],
        });
      }
    }
    return ops;
  });
}

const noProject = () => undefined;
const text = (r: { content: Array<{ text: string }> }) => r.content[0]!.text;

describe("mcp tool handlers", () => {
  let kernel: ReMemKernel;

  beforeEach(() => {
    kernel = new ReMemKernel({ consolidator: scripted() });
  });

  it("recall abstains rather than guessing when the store is empty", async () => {
    const res = await handleTool(
      kernel,
      "recall",
      { query: "editor" },
      noProject,
    );
    expect(text(res)).toBe(NO_MEMORY);
  });

  it("recall requires a query", async () => {
    const res = await handleTool(kernel, "recall", {}, noProject);
    expect(text(res)).toMatch(/requires a query/);
  });

  it("remember appends to the ledger and says so", async () => {
    const res = await handleTool(
      kernel,
      "remember",
      { text: "I work in Pacific time" },
      noProject,
    );
    expect(text(res)).toMatch(/Recorded observation/);
    expect(kernel.observations()).toHaveLength(1);
  });

  it("remember rejects empty text", async () => {
    const res = await handleTool(
      kernel,
      "remember",
      { text: "   " },
      noProject,
    );
    expect(text(res)).toMatch(/requires text/);
    expect(kernel.observations()).toHaveLength(0);
  });

  it("beliefs reports emptiness rather than an empty string", async () => {
    const res = await handleTool(kernel, "beliefs", {}, noProject);
    expect(text(res)).toBe("No active beliefs yet.");
  });

  it("recall surfaces belief ids so why has something to take", async () => {
    await kernel.observe({
      source: "manual",
      actor: "user",
      content: "prefers vim",
    });
    await kernel.consolidate();

    const res = await handleTool(
      kernel,
      "recall",
      { query: "editor" },
      noProject,
    );
    const body = text(res);
    expect(body).toMatch(/belief ids: /);

    const id = body.split("belief ids: ")[1]!.split(",")[0]!.trim();
    const why = await handleTool(kernel, "why", { belief_id: id }, noProject);
    expect(text(why)).toMatch(/editor = vim/);
    expect(text(why)).toMatch(/supported by:/);
    expect(text(why)).toMatch(/prefers vim/);
  });

  it("why reports an unknown id instead of throwing", async () => {
    const res = await handleTool(
      kernel,
      "why",
      { belief_id: "nope" },
      noProject,
    );
    expect(text(res)).toBe("Unknown belief: nope");
  });

  it("why requires an id", async () => {
    const res = await handleTool(kernel, "why", {}, noProject);
    expect(text(res)).toMatch(/requires a belief_id/);
  });

  it("keeps the superseded value reachable after a contradiction", async () => {
    await kernel.observe({
      source: "manual",
      actor: "user",
      content: "prefers vim",
    });
    await kernel.consolidate();
    await kernel.observe({
      source: "manual",
      actor: "user",
      content: "actually prefers emacs",
    });
    await kernel.consolidate();

    const active = kernel.beliefs({ status: "active" });
    const superseded = kernel.beliefs({ status: "superseded" });
    expect(active.map((b) => b.value)).toEqual(["emacs"]);
    expect(superseded.map((b) => b.value)).toEqual(["vim"]);

    // The agent-facing surface shows only the current value.
    const res = await handleTool(kernel, "beliefs", {}, noProject);
    expect(text(res)).toMatch(/editor=emacs/);
    expect(text(res)).not.toMatch(/editor=vim/);
  });

  it("passes project scope through to observations", async () => {
    await handleTool(
      kernel,
      "remember",
      { text: "uses pnpm here", project: "/repo/a" },
      (given) => given,
    );
    expect(kernel.observations()[0]!.contextSnapshot?.project).toBe("/repo/a");
  });

  it("names unknown tools rather than failing silently", async () => {
    const res = await handleTool(kernel, "destroy", {}, noProject);
    expect(text(res)).toBe("Unknown tool: destroy");
  });
});
