/**
 * Drive MemoryBench across several providers on an IDENTICAL question set.
 *
 * Why this exists rather than the CLI: the CLI exposes no sampling flag, and
 * the orchestrator's own `sample` mode shuffles with an unseeded Math.random().
 * Since each provider is a separate orchestrator.run() call, that would hand
 * every provider a DIFFERENT random sample and silently invalidate the whole
 * comparison. So we stratify once here with a seeded shuffle, then pass the
 * resulting questionIds explicitly to every provider.
 *
 * Everything else is held constant across providers: benchmark, question set,
 * answering model, judge. The only variable is the memory backend.
 *
 * Usage:
 *   bun run run-compare.ts --providers remem,mem0,supermemory,rag,filesystem \
 *     --benchmark locomo --per-category 25 --seed 42 \
 *     --judge gpt-4o --model gpt-5-mini --run-id strat1
 */
import { Orchestrator } from "./src/orchestrator"
import { createBenchmark } from "./src/benchmarks"
import type { ProviderName } from "./src/types/provider"
import type { BenchmarkName } from "./src/types/benchmark"

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]!
  if (fallback !== undefined) return fallback
  throw new Error(`missing required --${name}`)
}

/** Deterministic PRNG so the same seed always yields the same sample. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const providers = arg("providers").split(",").map((s) => s.trim()) as ProviderName[]
const benchmarkName = arg("benchmark", "locomo") as BenchmarkName
const perCategory = Number(arg("per-category", "25"))
const seed = Number(arg("seed", "42"))
const judge = arg("judge", "gpt-4o")
const model = arg("model", "gpt-5-mini")
const runId = arg("run-id")
const concurrency = Number(arg("concurrency", "2"))

// Stratify ONCE, seeded, so every provider sees the same questions.
const benchmark = createBenchmark(benchmarkName)
await benchmark.load()
const all = benchmark.getQuestions()

const byType: Record<string, string[]> = {}
for (const q of all) {
  ;(byType[q.questionType] ??= []).push(q.questionId)
}

const rand = mulberry32(seed)
const questionIds: string[] = []
const perTypeCounts: Record<string, number> = {}
for (const [type, ids] of Object.entries(byType).sort(([a], [b]) => a.localeCompare(b))) {
  const shuffled = [...ids].sort(() => rand() - 0.5)
  const picked = shuffled.slice(0, perCategory)
  questionIds.push(...picked)
  perTypeCounts[type] = picked.length
}

console.log(
  `MemoryBench comparison\n` +
    `  providers:  ${providers.join(", ")}\n` +
    `  benchmark:  ${benchmarkName}\n` +
    `  sampling:   stratified, ${perCategory} per category, seed ${seed}\n` +
    `  questions:  ${questionIds.length} of ${all.length}\n` +
    `  per type:   ${JSON.stringify(perTypeCounts)}\n` +
    `  answerer:   ${model}\n` +
    `  judge:      ${judge}\n` +
    `  concurrency: ${concurrency} (paced for provider and OpenAI rate limits)\n` +
    `  NOTE: the identical question set is passed to every provider.\n`
)

const orchestrator = new Orchestrator()
const failures: { provider: string; error: string }[] = []

for (const provider of providers) {
  const id = `${runId}-${provider}`
  console.log(`\n=== ${provider} (run ${id}) ===`)
  try {
    await orchestrator.run({
      provider,
      benchmark: benchmarkName,
      judgeModel: judge,
      answeringModel: model,
      runId: id,
      questionIds,
      // Low concurrency is not a performance choice. At the default of 10 this
      // run hit three separate rate limits at once: OpenAI's 30k TPM cap on the
      // gpt-4o judge, mem0's request-rate limit, and Supermemory's credit
      // ceiling. Every provider must clear the slowest gate, so the run is
      // paced to the tightest one.
      concurrency: { default: concurrency },
      force: true,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`  ${provider} FAILED: ${msg}`)
    failures.push({ provider, error: msg })
  }
}

console.log(`\n=== done ===`)
if (failures.length) {
  for (const f of failures) console.log(`  ${f.provider} FAILED: ${f.error}`)
} else {
  console.log(`all ${providers.length} providers completed on the same ${questionIds.length} questions`)
}
