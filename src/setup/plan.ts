// What `remem-kernel setup` will do, decided from what the machine looks like.
// Pure so every case can be tested without a machine to break; the runner in
// ./run.ts does the probing and the executing.
import { isAbsolute, resolve } from "node:path";

export const MIN_NODE_MAJOR = 20;
export const RUNTIME_PLACEHOLDER = "<RUNTIME>";

export interface Probe {
  node: string;
  claude: boolean;
  npm: boolean;
  marketplaceSource?: string;
  pluginInstalled: boolean;
  runtimeKernelVersion?: string;
}
export interface SetupOptions {
  source: string;
  version: string;
}
export type Step =
  | { kind: "fail"; message: string; fix: string }
  | { kind: "run"; label: string; cmd: string; args: string[] }
  | { kind: "pin-kernel" }
  | { kind: "doctor" }
  | { kind: "done"; message: string };

export function normalizeSource(source: string): string {
  const looksLikePath =
    isAbsolute(source) || source.startsWith(".") || source.includes("\\");
  if (looksLikePath) return `directory:${resolve(source)}`;
  return `github:${source}`;
}

const claude = (label: string, ...args: string[]): Step => ({
  kind: "run",
  label,
  cmd: "claude",
  args,
});

export function planSetup(p: Probe, o: SetupOptions): Step[] {
  const major = Number(/^v?(\d+)/.exec(p.node)?.[1] ?? 0);
  if (major < MIN_NODE_MAJOR) {
    return [
      {
        kind: "fail",
        message: `Node ${p.node} is below ${MIN_NODE_MAJOR}`,
        fix: `Install Node ${MIN_NODE_MAJOR} or newer from https://nodejs.org`,
      },
    ];
  }
  if (!p.claude) {
    return [
      {
        kind: "fail",
        message: "the claude CLI is not on PATH",
        fix: "Install Claude Code from https://claude.com/claude-code, then run this again",
      },
    ];
  }
  if (!p.npm) {
    return [
      {
        kind: "fail",
        message: "npm is not on PATH",
        fix: "Install npm (it ships with Node), then run this again",
      },
    ];
  }

  const steps: Step[] = [];
  const wanted = normalizeSource(o.source);
  let pluginInstalled = p.pluginInstalled;

  if (p.marketplaceSource === undefined) {
    steps.push(
      claude(
        "add the reMem marketplace",
        "plugin",
        "marketplace",
        "add",
        o.source,
      ),
    );
  } else if (p.marketplaceSource !== wanted) {
    if (pluginInstalled) {
      steps.push(
        claude(
          "remove the plugin installed from the old source",
          "plugin",
          "uninstall",
          "remem@remem",
        ),
      );
      pluginInstalled = false;
    }
    steps.push(
      claude(
        "remove the marketplace registered from another source",
        "plugin",
        "marketplace",
        "remove",
        "remem",
      ),
    );
    steps.push(
      claude(
        "add the reMem marketplace",
        "plugin",
        "marketplace",
        "add",
        o.source,
      ),
    );
  } else {
    steps.push(
      claude(
        "refresh the reMem marketplace",
        "plugin",
        "marketplace",
        "update",
        "remem",
      ),
    );
  }

  steps.push(
    pluginInstalled
      ? claude("update the reMem plugin", "plugin", "update", "remem@remem")
      : claude("install the reMem plugin", "plugin", "install", "remem@remem"),
  );

  if (p.runtimeKernelVersion !== o.version) {
    steps.push({
      kind: "run",
      label: `fetch the reMem kernel ${o.version}`,
      cmd: "npm",
      args: [
        "install",
        "--prefix",
        RUNTIME_PLACEHOLDER,
        "--no-audit",
        "--no-fund",
        `remem-kernel@${o.version}`,
      ],
    });
  }

  // The hooks read ~/.remem/kernel-path.json before they look at the runtime,
  // so a pointer cached by an older global install would keep them on the old
  // kernel after this upgrade. Point it at the runtime every time: that is the
  // copy setup just made current.
  steps.push({ kind: "pin-kernel" });
  steps.push({ kind: "doctor" });
  steps.push({ kind: "done", message: "Restart Claude Code to load reMem." });
  return steps;
}
