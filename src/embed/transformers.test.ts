import { describe, it, expect, vi } from "vitest";
import {
  TransformersEmbedder,
  type FeatureExtractionPipeline,
  type PipelineFactory,
} from "./transformers.js";

// These tests inject a fake pipeline so they are hermetic: no model download, no
// @huggingface/transformers dependency required. They verify the wrapper's
// contract (dim handling, lazy single init, delegation), not the model itself.
// The real model path is verified out of band on a machine with network.

function fakePipeline(vector: number[]): FeatureExtractionPipeline {
  return async () => ({
    data: Float32Array.from(vector),
    dims: [vector.length],
  });
}

describe("TransformersEmbedder", () => {
  it("returns a Float32Array of the configured dimension", async () => {
    const embedder = new TransformersEmbedder({
      dim: 4,
      pipelineFactory: async () => fakePipeline([0.1, 0.2, 0.3, 0.4]),
    });
    const vec = await embedder.embed("hello");
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(4);
    expect(embedder.dim).toBe(4);
    expect(Array.from(vec).map((v) => Number(v.toFixed(1)))).toEqual([
      0.1, 0.2, 0.3, 0.4,
    ]);
  });

  it("initializes the pipeline once and reuses it across calls", async () => {
    const factory: PipelineFactory = vi.fn(async () =>
      fakePipeline([1, 0, 0, 0]),
    );
    const embedder = new TransformersEmbedder({
      dim: 4,
      pipelineFactory: factory,
    });
    await embedder.embed("a");
    await embedder.embed("b");
    await embedder.embed("c");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("pads when the model returns fewer values than dim", async () => {
    const embedder = new TransformersEmbedder({
      dim: 4,
      pipelineFactory: async () => fakePipeline([9, 9]),
    });
    const vec = await embedder.embed("x");
    expect(Array.from(vec)).toEqual([9, 9, 0, 0]);
  });

  it("truncates when the model returns more values than dim", async () => {
    const embedder = new TransformersEmbedder({
      dim: 2,
      pipelineFactory: async () => fakePipeline([1, 2, 3, 4]),
    });
    const vec = await embedder.embed("x");
    expect(Array.from(vec)).toEqual([1, 2]);
  });

  it("surfaces a clear error when pipeline initialization fails", async () => {
    // The optional dependency may or may not be installed, so this stays
    // hermetic: the factory rejects the way importTransformers does when the
    // package is absent, and the embedder must surface that actionable message
    // to the caller rather than swallowing it.
    const embedder = new TransformersEmbedder({
      dim: 4,
      pipelineFactory: async () => {
        throw new Error(
          "TransformersEmbedder needs the optional dependency " +
            "'@huggingface/transformers'. Install it (pnpm add " +
            "@huggingface/transformers) to use local transformer embeddings, " +
            "or use HashingEmbedder.",
        );
      },
    });
    await expect(embedder.embed("x")).rejects.toThrow(
      /@huggingface\/transformers/,
    );
  });
});
