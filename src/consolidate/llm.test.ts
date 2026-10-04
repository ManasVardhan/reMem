import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createOpenAICompleter } from "./llm.js";

describe("createOpenAICompleter", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Mock fetch to capture the request body
    fetchSpy = vi.fn();
    (global as Record<string, unknown>).fetch = fetchSpy;

    // Set a dummy API key so the completer doesn't throw
    process.env.OPENAI_API_KEY = "test-key";
  });

  afterEach(() => {
    // Clean up environment variables set by tests
    delete process.env.OPENAI_TEMPERATURE;
  });

  it("sends temperature 0 when OPENAI_TEMPERATURE is unset", async () => {
    // Ensure OPENAI_TEMPERATURE is not set
    if ("OPENAI_TEMPERATURE" in process.env) {
      delete process.env.OPENAI_TEMPERATURE;
    }

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"ops":[]}' } }],
      }),
    });

    const completer = createOpenAICompleter();
    await completer([{ role: "user", content: "test" }]);

    expect(fetchSpy).toHaveBeenCalled();
    const [, config] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse(config.body as string);

    expect(body).toHaveProperty("temperature");
    expect(body.temperature).toBe(0);
  });

  it("omits temperature when OPENAI_TEMPERATURE=default", async () => {
    process.env.OPENAI_TEMPERATURE = "default";

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"ops":[]}' } }],
      }),
    });

    const completer = createOpenAICompleter();
    await completer([{ role: "user", content: "test" }]);

    expect(fetchSpy).toHaveBeenCalled();
    const [, config] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse(config.body as string);

    expect(body).not.toHaveProperty("temperature");
  });

  it("sends parsed temperature when OPENAI_TEMPERATURE=0.7", async () => {
    process.env.OPENAI_TEMPERATURE = "0.7";

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"ops":[]}' } }],
      }),
    });

    const completer = createOpenAICompleter();
    await completer([{ role: "user", content: "test" }]);

    expect(fetchSpy).toHaveBeenCalled();
    const [, config] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse(config.body as string);

    expect(body).toHaveProperty("temperature");
    expect(body.temperature).toBe(0.7);
  });

  it("prefers explicit options.temperature over env var", async () => {
    process.env.OPENAI_TEMPERATURE = "0.5";

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"ops":[]}' } }],
      }),
    });

    const completer = createOpenAICompleter({ temperature: 0.9 });
    await completer([{ role: "user", content: "test" }]);

    expect(fetchSpy).toHaveBeenCalled();
    const [, config] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse(config.body as string);

    expect(body.temperature).toBe(0.9);
  });

  it("ignores invalid OPENAI_TEMPERATURE and falls back to default 0", async () => {
    process.env.OPENAI_TEMPERATURE = "not-a-number";

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"ops":[]}' } }],
      }),
    });

    const completer = createOpenAICompleter();
    await completer([{ role: "user", content: "test" }]);

    expect(fetchSpy).toHaveBeenCalled();
    const [, config] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse(config.body as string);

    expect(body.temperature).toBe(0);
  });
});
