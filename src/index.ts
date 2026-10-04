export { ReMemKernel } from "./kernel.js";
export type { KernelOptions, Provenance } from "./kernel.js";

export { HashingEmbedder } from "./embed/index.js";
export type { Embedder } from "./embed/index.js";
export {
  TransformersEmbedder,
  createTransformersEmbedder,
} from "./embed/transformers.js";
export type {
  TransformersEmbedderOptions,
  PipelineFactory,
  FeatureExtractionPipeline,
  FeatureExtractionOutput,
} from "./embed/transformers.js";

export { openDb, ensureFts, hasFts, syncFts } from "./db/client.js";
export {
  selectEmbedder,
  storeIdentity,
  readIdentity,
  writeIdentity,
  HASHING_IDENTITY,
  TRANSFORMERS_IDENTITY,
} from "./embed/select.js";
export type { EmbedderIdentity, SelectedEmbedder } from "./embed/select.js";
export { reembed } from "./embed/reembed.js";
export type { ReembedReport, ReembedOptions } from "./embed/reembed.js";
export type { DB, OpenOptions } from "./db/client.js";

export { userAuthored, isMachineAuthored } from "./ingest/authored.js";
export { locomoToObservations } from "./ingest/locomo.js";
export type { LocomoDialogue } from "./ingest/locomo.js";

// Consolidation surface.
export { FunctionConsolidator } from "./consolidate/consolidator.js";
export type {
  Consolidator,
  ConsolidationContext,
} from "./consolidate/consolidator.js";
export { LLMConsolidator, createOpenAICompleter } from "./consolidate/llm.js";
export type {
  ChatCompleter,
  ChatMessage,
  LLMConsolidatorOptions,
  OpenAICompleterOptions,
} from "./consolidate/llm.js";
export { parseOps, beliefOpSchema } from "./consolidate/ops.js";
export type {
  BeliefOp,
  CreateOp,
  ReinforceOp,
  ContradictOp,
  RefineOp,
  NoopOp,
} from "./consolidate/ops.js";
export { applyOps } from "./consolidate/reducer.js";
export type {
  ConsolidationReport,
  ReducerOptions,
} from "./consolidate/reducer.js";
export type { ConsolidateOptions } from "./consolidate/index.js";
export {
  getWatermark,
  setWatermark,
  DEFAULT_BATCH,
} from "./consolidate/index.js";
export { deriveEpisode, renderWindow } from "./consolidate/episode.js";
export type {
  EpisodeProposal,
  DeriveEpisodeOptions,
} from "./consolidate/episode.js";

// Belief store surface.
export {
  SELF_ENTITY_ID,
  canonicalBeliefText,
  listBeliefs,
  getBelief,
  listEdges,
  getProvenanceObservationIds,
  beliefsFromObservation,
  findEquivalentBelief,
} from "./beliefs/store.js";
export { forgetBelief } from "./beliefs/store.js";
export type { BeliefFilter, EdgeFilter } from "./beliefs/store.js";
export { decayRateFor, DEFAULT_HALF_LIVES_DAYS } from "./beliefs/rates.js";

// Decay surface.
export {
  effectiveConfidence,
  withEffectiveConfidence,
  runDecay,
} from "./decay/index.js";
export type {
  DecayOptions,
  DecayReport,
  EffectiveBelief,
} from "./decay/index.js";

// Recall surface.
export { recall, scopeCompatible, scopeMatchScore } from "./recall/index.js";
export { Bm25Index, tokenize } from "./recall/bm25.js";
export type {
  RecallContext,
  RecallOptions,
  Reranker,
  ContextPack,
  PackedBelief,
  PackedObservation,
  ScoredBelief,
  ScoredObservation,
} from "./recall/index.js";
export type { Bm25Doc } from "./recall/bm25.js";

// Sessions and episodes: the readable account over the ledger.
export {
  startSession,
  endSession,
  countPrompt,
  setSessionTitle,
  getSession,
  listSessions,
  listProjects,
  isAutomatedSession,
} from "./sessions/index.js";
export type { StartSessionInput, SessionQuery } from "./sessions/index.js";
export {
  putEpisode,
  getEpisode,
  listEpisodes,
  countEpisodes,
  getEpisodeObservationIds,
} from "./episodes/index.js";
export type { EpisodeInput, EpisodeQuery } from "./episodes/index.js";

// Lexical search and timeline, distinct from semantic recall().
export { search, timeline, toMatchQuery } from "./search/index.js";
export type {
  SearchQuery,
  SearchResult,
  SearchHit,
  SearchKind,
  TimelineOptions,
  TimelineEntry,
} from "./search/index.js";

// Export / sovereignty surface.
export { exportSnapshot, SNAPSHOT_VERSION } from "./export/index.js";
export type {
  KernelSnapshot,
  ExportedObservation,
  ExportedBelief,
  ExportedProvenance,
} from "./export/index.js";

// Integration surface: the two-hook assistant API (record + contextBlock) with
// a local-first factory. This is the entry point an assistant host
// (for example a personal assistant's message loop) uses.
export {
  MemoryService,
  createMemoryService,
  defaultDataDir,
  defaultDbPath,
} from "./integration/index.js";
export type {
  ConversationTurn,
  MemoryServiceOptions,
  MemoryContext,
} from "./integration/index.js";

// Evaluation harness surface.
export { runEval } from "./eval/runner.js";
export type {
  RunOptions,
  EvalReport,
  SystemMetrics,
  AbilityMetrics,
} from "./eval/runner.js";
export {
  NoMemorySystem,
  FullContextSystem,
  NaiveVectorSystem,
  ReMemSystem,
} from "./eval/systems.js";
export { syntheticDataset, fixtureConsolidator } from "./eval/fixtures.js";
export { renderReport } from "./eval/report.js";
export { loadExternalDataset, EXTERNAL_DATASETS } from "./eval/datasets.js";
export type { ExternalDataset, LoadOptions } from "./eval/datasets.js";
export { loadLocomoDataset } from "./eval/locomo.js";
export type { LoadLocomoOptions } from "./eval/locomo.js";
export type {
  Ability,
  EvalObservation,
  EvalCase,
  EvalDataset,
  Retrieval,
  MemorySystem,
} from "./eval/types.js";

export type {
  SessionRecord,
  SessionStatus,
  EpisodeRecord,
  EpisodeKind,
  Actor,
  Source,
  ContextSnapshot,
  ObservationInput,
  ObservationRecord,
  BeliefKind,
  BeliefStatus,
  Scope,
  BeliefRecord,
  EntityType,
  EntityRecord,
  EdgeType,
  EdgeRecord,
} from "./types/index.js";

export { selectCompleter } from "./consolidate/select.js";
export type {
  CompleterSource,
  SelectedCompleter,
} from "./consolidate/select.js";
export {
  createAnthropicCompleter,
  anthropicAvailable,
} from "./consolidate/anthropic.js";
export {
  createAgentSdkCompleter,
  agentSdkAvailable,
} from "./consolidate/agent-sdk.js";
export {
  createClaudeCliCompleter,
  claudeCliAvailable,
} from "./consolidate/claude-cli.js";
export type { ClaudeCliOptions } from "./consolidate/claude-cli.js";
export { inScopeByConfidence } from "./mcp/scope.js";
