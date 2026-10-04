// Tool handling, separated from transport so it can be tested without stdio.
//
// Every handler takes an explicit kernel: no module-level state, so a test can
// hand in an in-memory kernel and assert on the text a model would actually
// see.

import type { ReMemKernel } from "../kernel.js";

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export const NO_MEMORY =
  "No relevant memory. The kernel abstained rather than guess.";

export async function handleTool(
  kernel: ReMemKernel,
  name: string,
  args: Record<string, unknown>,
  projectFor: (given: string | undefined) => string | undefined,
): Promise<ToolResult> {
  switch (name) {
    case "recall": {
      const query = String(args.query ?? "").trim();
      if (!query) return textResult("recall requires a query");
      const project = projectFor(args.project as string | undefined);
      const pack = await kernel.recall(query, project ? { project } : {});
      if (pack.abstained || pack.text === "") return textResult(NO_MEMORY);
      const ids = pack.beliefs.map((b) => b.id);
      const idLine = ids.length ? `\n\nbelief ids: ${ids.join(", ")}` : "";
      return textResult(`${pack.text}${idLine}`);
    }

    case "remember": {
      const content = String(args.text ?? "").trim();
      if (!content) return textResult("remember requires text");
      const project = projectFor(args.project as string | undefined);
      const obs = await kernel.observe({
        source: "manual",
        actor: "user",
        content,
        ...(project ? { contextSnapshot: { project } } : {}),
      });
      return textResult(
        `Recorded observation ${obs.id}. It enters the ledger now and is consolidated into beliefs at session end.`,
      );
    }

    case "beliefs": {
      const list = kernel.effectiveBeliefs({ status: "active" });
      if (list.length === 0) return textResult("No active beliefs yet.");
      return textResult(
        list
          .slice(0, 50)
          .map(
            (b) =>
              `${b.id}  ${b.predicate}=${b.value}  (confidence ${b.effectiveConfidence.toFixed(2)})`,
          )
          .join("\n"),
      );
    }

    case "search": {
      const query = String(args.query ?? "").trim();
      if (!query) return textResult("search requires a query");
      const kinds = String(args.kinds ?? "")
        .split(",")
        .map((k) => k.trim())
        .filter(
          (k) => k === "observation" || k === "episode" || k === "belief",
        );
      const result = kernel.search({
        query,
        ...(args.project ? { project: String(args.project) } : {}),
        ...(kinds.length
          ? { kinds: kinds as Array<"observation" | "episode" | "belief"> }
          : {}),
        limit: Number(args.limit ?? 20),
      });
      if (result.hits.length === 0) {
        return textResult(`Nothing in memory matches "${query}".`);
      }
      // Ids first on each line: the next call the model makes is almost always
      // observation(id), and it should not have to parse prose to find one.
      const lines = result.hits.map((h) => {
        const when = new Date(h.ts).toISOString().slice(0, 10);
        const where = h.project ? ` [${h.project}]` : "";
        return `${h.id}  ${when}${where}  (${h.kind}) ${h.title}`;
      });
      return textResult(
        `${result.total} result${result.total === 1 ? "" : "s"} for "${query}":\n\n${lines.join("\n")}`,
      );
    }

    case "history": {
      const anchorId = args.anchor ? String(args.anchor) : undefined;
      let anchorTs = Date.now();
      if (anchorId) {
        const obs = kernel.observation(anchorId);
        const ep = obs ? undefined : kernel.getEpisode(anchorId);
        if (!obs && !ep) return textResult(`Unknown id: ${anchorId}`);
        anchorTs = obs?.ts ?? ep?.ts ?? anchorTs;
      }
      const entries = kernel.timeline({
        anchorTs,
        ...(args.project ? { project: String(args.project) } : {}),
        ...(args.before !== undefined ? { before: Number(args.before) } : {}),
        ...(args.after !== undefined ? { after: Number(args.after) } : {}),
      });
      if (entries.length === 0)
        return textResult("Nothing recorded around that point.");
      const lines = entries.map((e) => {
        const when = new Date(e.ts).toISOString().slice(11, 16);
        const mark = e.anchor ? ">" : " ";
        const who = e.kind === "episode" ? "account" : (e.actor ?? "");
        return `${mark} ${when}  ${who.padEnd(9)} ${e.title}`;
      });
      return textResult(lines.join("\n"));
    }

    case "observation": {
      const id = String(args.id ?? "").trim();
      if (!id) return textResult("observation requires an id");

      const obs = kernel.observation(id);
      if (obs) {
        const ctx = obs.contextSnapshot as Record<string, unknown>;
        const head = `${obs.actor}, ${new Date(obs.ts).toISOString()}${
          ctx.projectName ? ` [${String(ctx.projectName)}]` : ""
        }`;
        const derived = kernel
          .beliefsFrom(id)
          .map((b) => `  ${b.predicate} = ${b.value} (${b.status})`);
        const became = derived.length
          ? `\n\nWhat memory made of it:\n${derived.join("\n")}`
          : "\n\nNot yet consolidated into any belief.";
        return textResult(`${head}\n\n${obs.content}${became}`);
      }

      const episode = kernel.getEpisode(id);
      if (!episode) return textResult(`Unknown id: ${id}`);
      const parts = [
        `${episode.kind}, ${new Date(episode.ts).toISOString()}${
          episode.project ? ` [${episode.project}]` : ""
        }`,
        "",
        episode.title,
        ...(episode.subtitle ? [episode.subtitle] : []),
        ...(episode.narrative ? ["", episode.narrative] : []),
      ];
      if (episode.facts.length) {
        parts.push("", "Facts:", ...episode.facts.map((f) => `  - ${f}`));
      }
      if (episode.filesChanged.length) {
        parts.push("", `Changed: ${episode.filesChanged.join(", ")}`);
      }
      const sources = kernel.whyEpisode(id).observations;
      if (sources.length) {
        parts.push(
          "",
          "Drawn from:",
          ...sources
            .slice(0, 5)
            .map((o) => `  ${o.id}  ${o.content.slice(0, 100)}`),
        );
      }
      return textResult(parts.join("\n"));
    }

    case "why": {
      const id = String(args.belief_id ?? "").trim();
      if (!id)
        return textResult("why requires a belief_id, from recall or beliefs");
      try {
        const { belief, observations } = kernel.why(id);
        const head = `${belief.predicate} = ${belief.value}  (${belief.status}, confidence ${belief.confidence.toFixed(2)})`;
        const body = observations.length
          ? observations
              .map((o) => `  - [${new Date(o.ts).toISOString()}] ${o.content}`)
              .join("\n")
          : "  (no observations found)";
        return textResult(`${head}\nsupported by:\n${body}`);
      } catch {
        return textResult(`Unknown belief: ${id}`);
      }
    }

    default:
      return textResult(`Unknown tool: ${name}`);
  }
}
