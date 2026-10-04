import { describe, it, expect, afterEach, vi } from "vitest";

const KEYS = [
  "REMEM_CONSOLIDATOR_PROVIDER",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  vi.resetModules();
  vi.restoreAllMocks();
});

// Both zero-config providers are stubbed rather than probed. The Agent SDK is
// an optional peer that is expensive to boot, and the claude CLI's presence
// depends on the machine the tests happen to run on, which would make the
// ordering assertions below pass or fail by accident.
async function selectWith(sdkAvailable: boolean, cliAvailable = false) {
  vi.doMock("./agent-sdk.js", () => ({
    agentSdkAvailable: async () => sdkAvailable,
    createAgentSdkCompleter: async () => async () => "sdk",
  }));
  vi.doMock("./claude-cli.js", () => ({
    claudeCliAvailable: async () => cliAvailable,
    createClaudeCliCompleter: () => async () => "cli",
  }));
  const { selectCompleter } = await import("./select.js");
  return selectCompleter();
}

describe("consolidator provider selection", () => {
  it("prefers the Agent SDK, which needs no key from the user", async () => {
    delete process.env.REMEM_CONSOLIDATOR_PROVIDER;
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const got = await selectWith(true);
    expect(got.source).toBe("agent-sdk");
    expect(got.complete).toBeTypeOf("function");
  });

  it("falls back to the claude CLI, which a Claude Code user already has", async () => {
    delete process.env.REMEM_CONSOLIDATOR_PROVIDER;
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const got = await selectWith(false, true);
    // Ahead of the API key: the point is that a plugin user configures nothing.
    expect(got.source).toBe("claude-cli");
    expect(got.complete).toBeTypeOf("function");
  });

  it("prefers the SDK over the CLI when both are present", async () => {
    delete process.env.REMEM_CONSOLIDATOR_PROVIDER;
    expect((await selectWith(true, true)).source).toBe("agent-sdk");
  });

  it("an explicit provider overrides both zero-config paths", async () => {
    process.env.REMEM_CONSOLIDATOR_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect((await selectWith(true, true)).source).toBe("anthropic");
  });

  it("falls back to the Anthropic API when the SDK is absent", async () => {
    delete process.env.REMEM_CONSOLIDATOR_PROVIDER;
    process.env.ANTHROPIC_API_KEY = "sk-test";
    delete process.env.OPENAI_API_KEY;
    expect((await selectWith(false)).source).toBe("anthropic");
  });

  it("falls back to OpenAI-compatible last", async () => {
    delete process.env.REMEM_CONSOLIDATOR_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test";
    expect((await selectWith(false)).source).toBe("openai");
  });

  it("reports none rather than throwing when nothing is configured", async () => {
    delete process.env.REMEM_CONSOLIDATOR_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const got = await selectWith(false);
    expect(got.source).toBe("none");
    expect(got.complete).toBeUndefined();
  });

  it("lets an explicit provider override the SDK", async () => {
    process.env.REMEM_CONSOLIDATOR_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect((await selectWith(true)).source).toBe("anthropic");
  });

  it("honours claude-cli as a forced provider", async () => {
    // The escape hatch for a slow or broken Agent SDK. Without this branch the
    // SDK still won and the setting did nothing.
    process.env.REMEM_CONSOLIDATOR_PROVIDER = "claude-cli";
    expect((await selectWith(true, true)).source).toBe("claude-cli");
  });
});
