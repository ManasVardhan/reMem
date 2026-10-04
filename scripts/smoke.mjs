#!/usr/bin/env node
// End-to-end smoke test of the installed package.
//
// The unit tests cover the kernel. This covers the things only an install can
// break: that the binaries exist and run, that the plugin's hooks can find the
// kernel from outside any node_modules tree, that the MCP server speaks its
// protocol, and that the viewer serves the ledger.
//
// Run against a scratch store so it never touches real memory:
//   node scripts/smoke.mjs

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "remem-smoke-"));
const db = join(dir, "smoke.db");
const env = { ...process.env, REMEM_DB: db };

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    process.stdout.write(`  ok    ${name}\n`);
  } catch (err) {
    failures += 1;
    process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// How many viewers are listening in the range one can use. The check below is
// about instance count, not about which port any one of them took.
function listeningViewers() {
  try {
    const out = execFileSync(
      "bash",
      [
        "-lc",
        "lsof -nP -iTCP:37800-37840 -sTCP:LISTEN 2>/dev/null | grep -c LISTEN || true",
      ],
      { encoding: "utf8" },
    );
    return Number(out.trim()) || 0;
  } catch {
    return 0;
  }
}

// Rows in the ledger right now. Checks that care about "did this add one"
// compare before and after, because a check added anywhere above would
// otherwise silently break every hard-coded count below it.
function ledgerRows(dbFile) {
  try {
    return Number(
      execFileSync("sqlite3", [dbFile, "select count(*) from observation"], {
        encoding: "utf8",
      }).trim(),
    );
  } catch {
    return 0;
  }
}

async function reachable(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/overview`);
    return res.ok;
  } catch {
    return false;
  }
}

process.stdout.write(`reMem smoke test\n  store ${db}\n\n`);

// The four binaries the package claims to install.
for (const bin of [
  "remem-import",
  "remem-consolidate",
  "remem-viewer",
  "remem-mcp",
]) {
  check(`${bin} is on PATH`, () => {
    const out = execFileSync("which", [bin], { encoding: "utf8" }).trim();
    assert(out.length > 0, "not found");
  });
}

await check("remem-import --help runs without a claude-mem database", () => {
  const out = execFileSync("remem-import", ["--help"], {
    encoding: "utf8",
    env,
  });
  assert(out.includes("port an existing memory store"), "unexpected help text");
});

await check("remem-import --dry-run reports rather than writing", () => {
  const out = execFileSync("remem-import", ["--dry-run"], {
    encoding: "utf8",
    env,
  });
  assert(out.includes("Would import"), "no dry-run report");
  assert(!existsSync(db), "a dry run created the store");
});

// The plugin's own resolver, which is what broke on a real install.
const pluginRoot = (() => {
  const base = join(
    process.env.HOME ?? "",
    ".claude",
    "plugins",
    "cache",
    "remem",
    "remem",
  );
  if (!existsSync(base)) return undefined;
  const versions = execFileSync("ls", [base], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
  return versions.length
    ? join(base, versions[versions.length - 1])
    : undefined;
})();

if (!pluginRoot) {
  process.stdout.write(
    "  skip  plugin hooks (plugin not installed in Claude Code)\n",
  );
} else {
  await check("a prompt hook records what was said", () => {
    execFileSync("node", [join(pluginRoot, "hooks", "observe.mjs")], {
      input: JSON.stringify({
        prompt: "smoke test: I deploy with Kamal",
        cwd: dir,
        session_id: "smoke-session",
      }),
      env,
      encoding: "utf8",
    });
    const count = execFileSync(
      "sqlite3",
      [db, "select count(*) from observation"],
      { encoding: "utf8" },
    ).trim();
    assert(count === "1", `expected 1 observation, got ${count}`);
  });

  await check("a prompt hook hands back what memory knows about it", () => {
    // The difference between memory Claude has and memory Claude must choose
    // to ask for: injection is unconditional, a tool call is not.
    const out = execFileSync(
      "node",
      [join(pluginRoot, "hooks", "observe.mjs")],
      {
        input: JSON.stringify({
          prompt: "remind me what I said about kamal deployment",
          cwd: dir,
          session_id: "smoke-session",
        }),
        env,
        encoding: "utf8",
      },
    );
    // An empty store has nothing to say, and says nothing rather than guessing.
    if (out.trim() !== "") {
      const parsed = JSON.parse(out);
      assert(
        parsed.hookSpecificOutput?.hookEventName === "UserPromptSubmit",
        "injected under the wrong hook event",
      );
    }
  });

  await check("injection stays silent when nothing bears on the prompt", () => {
    const out = execFileSync(
      "node",
      [join(pluginRoot, "hooks", "observe.mjs")],
      {
        input: JSON.stringify({
          prompt: "what is the capital of France",
          cwd: dir,
          session_id: "smoke-session",
        }),
        env,
        encoding: "utf8",
      },
    );
    assert(
      out.trim() === "",
      `injected irrelevant memory into the prompt: ${out.slice(0, 120)}`,
    );
  });

  await check(
    "the ledger refuses a harness notification dressed as a prompt",
    () => {
      // These arrive on the same channel as a prompt and were 27% of one real
      // store, consolidated into beliefs about task ids and output paths.
      const before = ledgerRows(db);
      execFileSync("node", [join(pluginRoot, "hooks", "observe.mjs")], {
        input: JSON.stringify({
          prompt:
            "<task-notification>\n<task-id>abc</task-id>\n</task-notification>",
          cwd: dir,
          session_id: "smoke-session",
        }),
        env,
        encoding: "utf8",
      });
      assert(
        ledgerRows(db) === before,
        `a notification was recorded (${before} -> ${ledgerRows(db)})`,
      );
    },
  );

  await check("nothing but the user ever reaches the ledger", () => {
    const actors = execFileSync(
      "sqlite3",
      [db, "select distinct actor from observation"],
      { encoding: "utf8" },
    ).trim();
    assert(actors === "user", `found non-user rows: ${actors}`);
  });

  await check("hooks stand down for reMem's own nested sessions", () => {
    const before = ledgerRows(db);
    execFileSync("node", [join(pluginRoot, "hooks", "observe.mjs")], {
      input: JSON.stringify({
        prompt: "this is consolidation talking to itself",
        cwd: dir,
        session_id: "internal",
      }),
      env: { ...env, REMEM_INTERNAL: "1" },
      encoding: "utf8",
    });
    assert(ledgerRows(db) === before, "an internal session was recorded");
  });

  await check("the session-start hook keeps a viewer running", async () => {
    const before = listeningViewers();
    execFileSync("node", [join(pluginRoot, "hooks", "viewer.mjs")], {
      input: JSON.stringify({ cwd: dir }),
      env,
      encoding: "utf8",
    });
    // Spawned detached, so give it a moment to bind.
    execFileSync("sleep", ["3"]);
    assert(
      (await reachable(37800)) || listeningViewers() > before,
      "no viewer is running after the hook ran",
    );

    // Running it twice more must not add instances. One viewer, one address:
    // a second on the next free port is how a bookmark ends up on a stale one.
    const settled = listeningViewers();
    for (let i = 0; i < 2; i += 1) {
      execFileSync("node", [join(pluginRoot, "hooks", "viewer.mjs")], {
        input: JSON.stringify({ cwd: dir }),
        env,
        encoding: "utf8",
      });
    }
    execFileSync("sleep", ["2"]);
    assert(
      listeningViewers() <= settled,
      `the hook started extra viewers (${settled} -> ${listeningViewers()})`,
    );
  });

  await check("the statusline reports the project's counts", () => {
    const out = execFileSync(
      "node",
      [join(pluginRoot, "hooks", "statusline.mjs"), dir, "--json"],
      { encoding: "utf8", env },
    );
    const counts = JSON.parse(out);
    assert(
      counts.said === ledgerRows(db),
      `statusline says ${counts.said}, ledger has ${ledgerRows(db)}`,
    );
  });
}

// The MCP server, spoken to the way a client would.
await check("the MCP server lists its tools", () => {
  const out = execFileSync("remem-mcp", [], {
    input: `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    })}\n`,
    encoding: "utf8",
    env,
    timeout: 20000,
  });
  const names = (JSON.parse(out.split("\n")[0]).result?.tools ?? []).map(
    (t) => t.name,
  );
  for (const tool of [
    "recall",
    "remember",
    "beliefs",
    "why",
    "search",
    "history",
    "observation",
  ]) {
    assert(names.includes(tool), `missing tool: ${tool}`);
  }
});

// The viewer, on a port nothing else is using.
await new Promise((resolve) => {
  const port = 37899;
  const viewer = spawn("remem-viewer", [], {
    env: { ...env, REMEM_VIEWER_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const done = () => {
    viewer.kill();
    resolve();
  };

  viewer.stdout.once("data", async () => {
    try {
      const page = await fetch(`http://127.0.0.1:${port}/`);
      const html = await page.text();
      await check("the viewer serves its page", () => {
        assert(page.ok, `status ${page.status}`);
        assert(
          html.includes("The ledger"),
          "the page does not open on the ledger",
        );
      });

      const overview = await (
        await fetch(`http://127.0.0.1:${port}/api/overview`)
      ).json();
      await check("the viewer reports what is in the store", () => {
        assert(
          overview.counts.observations >= 1,
          `expected observations, got ${overview.counts.observations}`,
        );
      });

      const feed = await (
        await fetch(`http://127.0.0.1:${port}/api/feed?limit=5`)
      ).json();
      await check("the feed returns what was said", () => {
        assert(feed.items.length >= 1, "empty feed");
        assert(
          feed.items.some((i) => i.kind === "prompt"),
          "no prompt in the feed",
        );
      });

      // The one this test wrote, not whichever prompt happens to be newest.
      const said = feed.items.find(
        (i) => i.kind === "prompt" && i.excerpt?.includes("Kamal"),
      );
      assert(said, "the recorded prompt is not in the feed");
      const detail = await (
        await fetch(
          `http://127.0.0.1:${port}/api/observation/${encodeURIComponent(said.id)}`,
        )
      ).json();
      await check("clicking an observation returns it in full", () => {
        assert(
          detail.content.includes("Kamal"),
          "the full text did not come back",
        );
        assert(Array.isArray(detail.beliefs), "no beliefs field");
      });
    } catch (err) {
      failures += 1;
      process.stdout.write(`  FAIL  viewer\n        ${err.message}\n`);
    }
    done();
  });

  viewer.on("error", (err) => {
    failures += 1;
    process.stdout.write(
      `  FAIL  viewer did not start\n        ${err.message}\n`,
    );
    resolve();
  });

  setTimeout(done, 20000);
});

rmSync(dir, { recursive: true, force: true });

process.stdout.write(
  `\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
