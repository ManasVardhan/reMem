// Carrying out the plan from ./plan.ts: probe, plan, then run each step in
// order and stop at the first thing that goes wrong. Output is collected as
// lines so tests can read it; onLine lets the CLI show each one as it happens,
// since an npm install with no output for a minute looks hung.
import { join } from "node:path";
import { planSetup, RUNTIME_PLACEHOLDER } from "./plan.js";
import { probe, type Exec } from "./probe.js";

// What setup needs from doctor: its verdict, plus the versions it found, so a
// plugin left running against a different kernel is caught here rather than
// passed off as a warning.
export interface DoctorVerdict {
  status: "ok" | "warn" | "fail";
  kernel?: { root: string; version: string };
  plugin?: { version: string };
}

export interface RunResult {
  code: 0 | 1;
  lines: string[];
}

export async function runSetup(o: {
  exec: Exec;
  runtimeDir: string;
  source: string;
  version: string;
  dryRun: boolean;
  doctor: () => Promise<DoctorVerdict>;
  // Writes the hooks' kernel pointer; resolves to a reason on failure.
  pinKernel: (root: string) => string | undefined;
  // True when REMEM_SETUP_VERSION picked the kernel, which can legitimately
  // differ from the plugin version (the smoke test fetches a published kernel
  // before the matching one exists).
  versionOverridden?: boolean;
  onLine?: (line: string) => void;
}): Promise<RunResult> {
  const out: string[] = [];
  const lines = {
    push(...ls: string[]): void {
      for (const l of ls) {
        out.push(l);
        o.onLine?.(l);
      }
    },
  };
  lines.push(
    `reMem setup ${o.version}${o.dryRun ? " (dry run, nothing will change)" : ""}`,
    "",
  );
  const steps = planSetup(await probe(o.exec, o.runtimeDir), {
    source: o.source,
    version: o.version,
  });

  for (const step of steps) {
    if (step.kind === "fail") {
      lines.push(`  x ${step.message}`, `    fix: ${step.fix}`);
      return { code: 1, lines: out };
    }
    if (step.kind === "run") {
      // The plan says <RUNTIME> so it stays pure and machine-independent; the
      // real path only appears here, at the point of execution.
      const args = step.args.map((a) =>
        a === RUNTIME_PLACEHOLDER ? o.runtimeDir : a,
      );
      lines.push(`  - ${step.label}: ${[step.cmd, ...args].join(" ")}`);
      if (o.dryRun) continue;
      const r = await o.exec(step.cmd, args);
      if (r.code !== 0) {
        lines.push(`  x ${step.cmd} exited ${r.code}`);
        // Some tools report failures on stdout only; an empty stderr would
        // otherwise leave the user with an exit code and no reason.
        const detail = r.stderr.trim() || r.stdout.trim();
        for (const l of detail.split("\n").slice(0, 5))
          if (l) lines.push(`    ${l}`);
        return { code: 1, lines: out };
      }
      continue;
    }
    if (step.kind === "pin-kernel") {
      const root = join(o.runtimeDir, "node_modules", "remem-kernel");
      lines.push(`  - point the plugin's hooks at ${root}`);
      if (o.dryRun) continue;
      const problem = o.pinKernel(root);
      if (problem !== undefined) {
        lines.push(
          `  x ${problem}`,
          "    fix: re-run npx remem-kernel@latest setup",
        );
        return { code: 1, lines: out };
      }
      continue;
    }
    if (step.kind === "doctor") {
      // Nothing was installed in a dry run, so there is nothing to verify.
      if (o.dryRun) continue;
      lines.push("  - check that memory works: npx remem-kernel doctor");
      // A fresh machine has no store yet, which doctor reports as a warning.
      // Only a failure means the install did not take.
      const verdict = await o.doctor();
      if (verdict.status === "fail") {
        lines.push("  x doctor found a failure; see its output above");
        return { code: 1, lines: out };
      }
      // Version skew is only a warning to doctor, but right after setup it
      // means setup did not do its job, so it must not end in "done".
      const plugin = verdict.plugin?.version;
      const kernel = verdict.kernel?.version;
      if (plugin !== undefined && kernel !== undefined && plugin !== kernel) {
        if (o.versionOverridden) {
          lines.push(
            `    note: plugin ${plugin} against kernel ${kernel}, as REMEM_SETUP_VERSION asked`,
          );
          continue;
        }
        lines.push(
          `  x the plugin is ${plugin} but the hooks load kernel ${kernel} from ${verdict.kernel?.root ?? "?"}`,
          "    fix: re-run npx remem-kernel@latest setup; if this persists, run",
          "         claude plugin update remem@remem and restart Claude Code",
        );
        return { code: 1, lines: out };
      }
      continue;
    }
    lines.push("", step.message);
  }
  return { code: 0, lines: out };
}
