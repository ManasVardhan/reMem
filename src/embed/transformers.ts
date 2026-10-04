import type { Embedder } from "./index.js";

// A production-grade local embedder backed by a sentence-transformer model run
// through @huggingface/transformers (ONNX). The model runs entirely on the
// user's machine: no API, no network after the first download (weights are
// cached on disk), which is exactly the local-first, sovereign stance the design
// requires.
//
// The dependency is optional and loaded lazily so the core kernel stays light
// and CI stays offline. HashingEmbedder remains the zero-config default; callers
// opt into this one for real recall quality. Tests inject a fake pipeline via
// `pipelineFactory`, so nothing here downloads a model in CI.

// The minimal shape of a transformers feature-extraction pipeline output: a flat
// tensor with its data and dims. Declared structurally so this module typechecks
// without the optional dependency installed.
export interface FeatureExtractionOutput {
  data: Float32Array | number[];
  dims: number[];
}

export type FeatureExtractionPipeline = (
  text: string | string[],
  options?: {
    pooling?: "mean" | "cls" | "none";
    normalize?: boolean;
  },
) => Promise<FeatureExtractionOutput>;

// Builds (and typically caches a model download for) a pipeline for the given
// model id. The default implementation dynamically imports the optional
// dependency; tests pass a fake.
export type PipelineFactory = (
  model: string,
) => Promise<FeatureExtractionPipeline>;

export interface TransformersEmbedderOptions {
  // Hugging Face model id. Defaults to a small, fast, well-understood
  // sentence-embedding model.
  model?: string;
  // Output dimensionality of the model. Must match the model; the default
  // pairs with all-MiniLM-L6-v2 (384).
  dim?: number;
  // Injected for tests and custom runtimes. Defaults to importing
  // @huggingface/transformers and building a feature-extraction pipeline.
  pipelineFactory?: PipelineFactory;
}

const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_DIM = 384;

// Dynamic import behind a non-literal specifier so TypeScript does not try to
// resolve the optional dependency at build time (the module stays `any`), and so
// this file compiles whether or not the package is installed.
async function importTransformers(): Promise<{
  pipeline: (task: string, model: string) => Promise<FeatureExtractionPipeline>;
}> {
  const specifier = "@huggingface/transformers";
  try {
    return (await import(/* @vite-ignore */ specifier)) as {
      pipeline: (
        task: string,
        model: string,
      ) => Promise<FeatureExtractionPipeline>;
    };
  } catch (cause) {
    throw new Error(
      "TransformersEmbedder needs the optional dependency " +
        "'@huggingface/transformers'. Install it (pnpm add " +
        "@huggingface/transformers) to use local transformer embeddings, or use " +
        "HashingEmbedder.",
      { cause },
    );
  }
}

const defaultPipelineFactory: PipelineFactory = async (model) => {
  const { pipeline } = await importTransformers();
  return pipeline("feature-extraction", model);
};

export class TransformersEmbedder implements Embedder {
  readonly dim: number;
  private readonly model: string;
  private readonly pipelineFactory: PipelineFactory;
  // The pipeline (and its one-time model download) is created lazily on first
  // embed and cached as a promise so concurrent calls share a single init.
  private pipelinePromise: Promise<FeatureExtractionPipeline> | undefined;

  constructor(options: TransformersEmbedderOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.dim = options.dim ?? DEFAULT_DIM;
    this.pipelineFactory = options.pipelineFactory ?? defaultPipelineFactory;
  }

  private ready(): Promise<FeatureExtractionPipeline> {
    if (!this.pipelinePromise) {
      this.pipelinePromise = this.pipelineFactory(this.model);
    }
    return this.pipelinePromise;
  }

  async embed(text: string): Promise<Float32Array> {
    const pipe = await this.ready();
    // Mean-pool token embeddings into one sentence vector and L2-normalize, so
    // cosine similarity downstream is a plain dot product (matching the
    // HashingEmbedder contract).
    const output = await pipe(text, { pooling: "mean", normalize: true });
    const data = output.data;
    const vec = new Float32Array(this.dim);
    const n = Math.min(this.dim, data.length);
    for (let i = 0; i < n; i++) {
      vec[i] = Number(data[i]);
    }
    return vec;
  }
}

// Factory mirroring createMemoryService(): reads clearly at call sites and is
// the documented entry point for opting into local transformer embeddings.
export function createTransformersEmbedder(
  options: TransformersEmbedderOptions = {},
): TransformersEmbedder {
  return new TransformersEmbedder(options);
}
