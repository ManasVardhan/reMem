import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"
import { ReMemProvider } from "./index"
import type { UnifiedSession } from "../../types/unified"

const BASE_URL = "http://localhost:8888"

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? status : 500,
    headers: { "content-type": "application/json" },
  })
}

describe("ReMemProvider", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  async function makeInitializedProvider(): Promise<ReMemProvider> {
    globalThis.fetch = mock(async () =>
      jsonResponse({ status: "ok", config: {}, users: 0 })
    ) as typeof fetch
    const provider = new ReMemProvider()
    await provider.initialize({ apiKey: "", baseUrl: BASE_URL })
    return provider
  }

  describe("initialize", () => {
    it("fails loudly when the health check does not respond ok", async () => {
      globalThis.fetch = mock(async () => jsonResponse({}, false, 500)) as typeof fetch
      const provider = new ReMemProvider()
      await expect(provider.initialize({ apiKey: "", baseUrl: BASE_URL })).rejects.toThrow(
        /unhealthy/
      )
    })

    it("fails loudly when the server is unreachable", async () => {
      globalThis.fetch = mock(async () => {
        throw new Error("connection refused")
      }) as typeof fetch
      const provider = new ReMemProvider()
      await expect(provider.initialize({ apiKey: "", baseUrl: BASE_URL })).rejects.toThrow(
        /not reachable/
      )
    })
  })

  describe("ingest", () => {
    it("sends the session date as a Unix-seconds timestamp", async () => {
      const provider = await makeInitializedProvider()

      let capturedBody: Record<string, unknown> | undefined
      globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
        capturedBody = JSON.parse(init!.body as string)
        return jsonResponse({ results: [{ id: "obs-1", memory: "hi", event: "ADD" }] })
      }) as typeof fetch

      const session: UnifiedSession = {
        sessionId: "sample-1-session_1",
        messages: [{ role: "user", content: "hi there" }],
        metadata: { date: "2023-05-04T14:30:00.000Z" },
      }

      await provider.ingest([session], { containerTag: "user-1" })

      expect(capturedBody).toBeDefined()
      expect(capturedBody!.timestamp).toBe(
        Math.floor(Date.parse("2023-05-04T14:30:00.000Z") / 1000)
      )
      expect(typeof capturedBody!.timestamp).toBe("number")
    })

    it("prefers a per-message timestamp over the session date when present", async () => {
      const provider = await makeInitializedProvider()

      let capturedBody: Record<string, unknown> | undefined
      globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
        capturedBody = JSON.parse(init!.body as string)
        return jsonResponse({ results: [] })
      }) as typeof fetch

      const session: UnifiedSession = {
        sessionId: "sample-1-session_1",
        messages: [{ role: "user", content: "hi", timestamp: "2024-01-01T00:00:00.000Z" }],
        metadata: { date: "2023-05-04T14:30:00.000Z" },
      }

      await provider.ingest([session], { containerTag: "user-1" })

      expect(capturedBody!.timestamp).toBe(
        Math.floor(Date.parse("2024-01-01T00:00:00.000Z") / 1000)
      )
    })

    it("prefixes message content with the speaker", async () => {
      const provider = await makeInitializedProvider()

      let capturedBody: Record<string, unknown> | undefined
      globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
        capturedBody = JSON.parse(init!.body as string)
        return jsonResponse({ results: [] })
      }) as typeof fetch

      const session: UnifiedSession = {
        sessionId: "sample-1-session_1",
        messages: [
          { role: "user", content: "I went to a support group yesterday.", speaker: "Caroline" },
          { role: "assistant", content: "That sounds tough.", speaker: "Melanie" },
        ],
        metadata: { date: "2023-05-04T14:30:00.000Z" },
      }

      await provider.ingest([session], { containerTag: "user-1" })

      const messages = capturedBody!.messages as { role: string; content: string }[]
      expect(messages[0].content).toBe("Caroline: I went to a support group yesterday.")
      expect(messages[1].content).toBe("Melanie: That sounds tough.")
    })

    it("falls back to role as the speaker label when speaker is absent", async () => {
      const provider = await makeInitializedProvider()

      let capturedBody: Record<string, unknown> | undefined
      globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
        capturedBody = JSON.parse(init!.body as string)
        return jsonResponse({ results: [] })
      }) as typeof fetch

      const session: UnifiedSession = {
        sessionId: "sample-1-session_1",
        messages: [{ role: "user", content: "no speaker here" }],
        metadata: { date: "2023-05-04T14:30:00.000Z" },
      }

      await provider.ingest([session], { containerTag: "user-1" })

      const messages = capturedBody!.messages as { role: string; content: string }[]
      expect(messages[0].content).toBe("user: no speaker here")
    })

    it("posts to /memories with the container tag as user_id and returns observation ids", async () => {
      const provider = await makeInitializedProvider()

      let capturedUrl: string | undefined
      globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
        capturedUrl = url
        const body = JSON.parse(init!.body as string)
        expect(body.user_id).toBe("user-42")
        return jsonResponse({
          results: [
            { id: "obs-1", memory: "hi there", event: "ADD" },
            { id: "obs-2", memory: "bye", event: "ADD" },
          ],
        })
      }) as typeof fetch

      const session: UnifiedSession = {
        sessionId: "sample-1-session_1",
        messages: [
          { role: "user", content: "hi there" },
          { role: "assistant", content: "bye" },
        ],
        metadata: { date: "2023-05-04T14:30:00.000Z" },
      }

      const result = await provider.ingest([session], { containerTag: "user-42" })

      expect(capturedUrl).toBe(`${BASE_URL}/memories`)
      expect(result.documentIds).toEqual(["obs-1", "obs-2"])
    })
  })

  describe("awaitIndexing", () => {
    it("is a no-op that reports everything already complete", async () => {
      const provider = await makeInitializedProvider()
      let fetchCalled = false
      globalThis.fetch = mock(async () => {
        fetchCalled = true
        return jsonResponse({})
      }) as typeof fetch

      let progress: { completedIds: string[]; failedIds: string[]; total: number } | undefined
      await provider.awaitIndexing({ documentIds: ["a", "b"] }, "user-1", (p) => {
        progress = p
      })

      expect(fetchCalled).toBe(false)
      expect(progress).toEqual({ completedIds: ["a", "b"], failedIds: [], total: 2 })
    })
  })

  describe("search", () => {
    it("preserves created_at on each result through the round trip", async () => {
      const provider = await makeInitializedProvider()

      const rawResults = [
        {
          id: "belief-1",
          memory: "likes hiking: true",
          score: 0.9,
          confidence: 0.8,
          evidence_count: 3,
          status: "active",
          created_at: null,
        },
        {
          id: "obs-1",
          memory: "Caroline: I went hiking last weekend.",
          score: 0.7,
          confidence: null,
          evidence_count: null,
          status: null,
          created_at: "2023-05-04T14:30:00.000Z",
        },
      ]

      let capturedBody: Record<string, unknown> | undefined
      globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
        capturedBody = JSON.parse(init!.body as string)
        return jsonResponse({ results: rawResults, signals: {} })
      }) as typeof fetch

      const results = await provider.search("hiking", { containerTag: "user-1", limit: 10 })

      expect(capturedBody).toEqual({ user_id: "user-1", query: "hiking", limit: 10 })
      expect(results).toEqual(rawResults)
      expect((results[0] as { created_at: string | null }).created_at).toBeNull()
      expect((results[1] as { created_at: string | null }).created_at).toBe(
        "2023-05-04T14:30:00.000Z"
      )
    })

    it("defaults the limit to 30 when not provided", async () => {
      const provider = await makeInitializedProvider()

      let capturedBody: Record<string, unknown> | undefined
      globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
        capturedBody = JSON.parse(init!.body as string)
        return jsonResponse({ results: [] })
      }) as typeof fetch

      await provider.search("hiking", { containerTag: "user-1" })

      expect(capturedBody!.limit).toBe(30)
    })
  })

  describe("clear", () => {
    it("sends a DELETE to /memories with the container tag as user_id", async () => {
      const provider = await makeInitializedProvider()

      let capturedUrl: string | undefined
      let capturedMethod: string | undefined
      globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
        capturedUrl = url
        capturedMethod = init?.method
        return jsonResponse({ message: "deleted", user_id: "user-1" })
      }) as typeof fetch

      await provider.clear("user-1")

      expect(capturedMethod).toBe("DELETE")
      expect(capturedUrl).toBe(`${BASE_URL}/memories?user_id=user-1`)
    })
  })
})
