import type {
  Provider,
  ProviderConfig,
  IngestOptions,
  IngestResult,
  SearchOptions,
  IndexingProgressCallback,
} from "../../types/provider"
import type { UnifiedSession, UnifiedMessage } from "../../types/unified"
import { logger } from "../../utils/logger"

const DEFAULT_BASE_URL = "http://localhost:8888"

interface ReMemIngestResponse {
  results: { id: string; memory: string; event: string }[]
}

interface ReMemSearchResponse {
  results: unknown[]
  signals?: unknown
}

/**
 * Derive a per-session Unix-seconds timestamp for POST /memories.
 *
 * LoCoMo (the only benchmark wired into MemoryBench today, see
 * src/benchmarks/locomo/index.ts) never sets UnifiedMessage.timestamp; it
 * parses the session's `session_N_date_time` field into an ISO string on
 * session.metadata.date (parseLocomoDate, called from extractSessions).
 * Prefer a per-message timestamp if a future benchmark supplies one, then
 * fall back to the session-level date. reMem's benchmark accuracy on
 * time-ordered questions depends on this timestamp reaching the kernel
 * (34% to 95.6% in internal evals), so a missing date is logged loudly
 * instead of silently defaulting to now.
 */
function deriveSessionTimestampSeconds(session: UnifiedSession): number {
  const messageTimestamp = session.messages.find((m) => m.timestamp)?.timestamp
  const sessionDate = session.metadata?.date as string | undefined
  const raw = messageTimestamp ?? sessionDate

  if (raw) {
    const ms = Date.parse(raw)
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000)
    logger.warn(
      `ReMem: could not parse timestamp "${raw}" for session ${session.sessionId}, defaulting to now`
    )
  } else {
    logger.warn(
      `ReMem: no timestamp available for session ${session.sessionId} ` +
        `(checked message.timestamp and session.metadata.date), defaulting to now. ` +
        `This degrades accuracy on time-ordered questions.`
    )
  }

  return Math.floor(Date.now() / 1000)
}

/**
 * reMem stores raw message content with no speaker field of its own.
 * Prefixing content with the speaker label (e.g. "Caroline: I went to a
 * support group yesterday.") is the convention that recovered
 * speaker-attribution accuracy in reMem's own eval harness. LoCoMo's loader
 * sets UnifiedMessage.speaker to the raw LoCoMo speaker name (extractSessions
 * in src/benchmarks/locomo/index.ts); fall back to role when a benchmark
 * doesn't supply a speaker.
 */
function formatContent(message: UnifiedMessage): string {
  const speaker = message.speaker ?? message.role
  return `${speaker}: ${message.content}`
}

export class ReMemProvider implements Provider {
  name = "remem"
  concurrency = {
    default: 10,
  }
  private baseUrl: string = DEFAULT_BASE_URL

  async initialize(config: ProviderConfig): Promise<void> {
    this.baseUrl = config.baseUrl || DEFAULT_BASE_URL

    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/health`)
    } catch (e) {
      throw new Error(`ReMem adapter not reachable at ${this.baseUrl}: ${e}`)
    }
    if (!response.ok) {
      throw new Error(`ReMem adapter at ${this.baseUrl} is unhealthy: ${response.status}`)
    }

    logger.info(`Initialized ReMem provider (${this.baseUrl})`)
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    const documentIds: string[] = []

    for (const session of sessions) {
      const timestamp = deriveSessionTimestampSeconds(session)
      const messages = session.messages.map((m) => ({
        role: m.role,
        content: formatContent(m),
      }))

      const response = await fetch(`${this.baseUrl}/memories`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          user_id: options.containerTag,
          timestamp,
          messages,
        }),
      })
      if (!response.ok) {
        throw new Error(
          `ReMem ingest failed for session ${session.sessionId}: ${response.status} ${await response.text()}`
        )
      }
      const data = (await response.json()) as ReMemIngestResponse
      for (const r of data.results) documentIds.push(r.id)
    }

    return { documentIds }
  }

  async awaitIndexing(
    result: IngestResult,
    _containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void> {
    // reMem indexes synchronously: POST /memories does not return until
    // observe() and consolidate() have both completed (see
    // reMem/src/eval/mem0-adapter-server.ts), so by the time ingest()
    // resolves everything is already searchable. Nothing to poll.
    onProgress?.({
      completedIds: result.documentIds,
      failedIds: [],
      total: result.documentIds.length,
    })
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    const response = await fetch(`${this.baseUrl}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        user_id: options.containerTag,
        query,
        limit: options.limit || 30,
      }),
    })
    if (!response.ok) {
      throw new Error(`ReMem search failed: ${response.status} ${await response.text()}`)
    }
    const data = (await response.json()) as ReMemSearchResponse
    // created_at is preserved as-is: the harness uses it to sort and date
    // results (ISO-8601 for observations, null for beliefs).
    return data.results ?? []
  }

  async clear(containerTag: string): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/memories?user_id=${encodeURIComponent(containerTag)}`,
      { method: "DELETE" }
    )
    if (!response.ok) {
      throw new Error(`ReMem clear failed for ${containerTag}: ${response.status}`)
    }
    logger.info(`Cleared memories for user: ${containerTag}`)
  }
}

export default ReMemProvider
