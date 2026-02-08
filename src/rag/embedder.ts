/**
 * embedder.ts — Embedding API abstraction layer
 *
 * Supports OpenAI and Google Gemini embedding models.
 * Used for building and querying the semantic search index.
 *
 * Configuration via environment variables:
 *   EMBEDDING_PROVIDER = "openai" | "gemini" (default: "gemini")
 *   EMBEDDING_MODEL    = model name (optional, uses provider default)
 *
 * Note: Anthropic does not offer an embedding API.
 * If using Anthropic as your LLM provider, choose OpenAI or Gemini for embeddings.
 */

import OpenAI from "openai";
import { GoogleGenerativeAI, TaskType } from "@google/generative-ai";

// ─── Interface ───────────────────────────────────────────

export interface Embedder {
  /** Embed a batch of texts (for document indexing) */
  embedBatch(texts: string[]): Promise<number[][]>;
  /** Embed a single query (for search — may use different task type) */
  embedQuery(text: string): Promise<number[]>;
  /** Vector dimensions */
  readonly dimensions: number;
  /** Model name */
  readonly modelName: string;
}

export type EmbeddingProviderName = "openai" | "gemini";

const DEFAULT_MODELS: Record<EmbeddingProviderName, string> = {
  openai: "text-embedding-3-small",
  gemini: "text-embedding-004",
};

const MODEL_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-004": 768,
};

// ─── OpenAI Embedder ─────────────────────────────────────

class OpenAIEmbedder implements Embedder {
  private client: OpenAI;
  readonly modelName: string;
  readonly dimensions: number;

  constructor(model?: string) {
    this.client = new OpenAI();
    this.modelName = model || DEFAULT_MODELS.openai;
    this.dimensions = MODEL_DIMENSIONS[this.modelName] || 1536;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: this.modelName,
      input: texts,
    });
    return response.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  async embedQuery(text: string): Promise<number[]> {
    const [embedding] = await this.embedBatch([text]);
    return embedding;
  }
}

// ─── Gemini Embedder ─────────────────────────────────────

class GeminiEmbedder implements Embedder {
  private genAI: GoogleGenerativeAI;
  readonly modelName: string;
  readonly dimensions: number;

  constructor(model?: string) {
    const key = process.env.GOOGLE_API_KEY;
    if (!key) throw new Error("GOOGLE_API_KEY is required for Gemini embeddings");
    this.genAI = new GoogleGenerativeAI(key);
    this.modelName = model || DEFAULT_MODELS.gemini;
    this.dimensions = MODEL_DIMENSIONS[this.modelName] || 768;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const model = this.genAI.getGenerativeModel({ model: this.modelName });
    const result = await model.batchEmbedContents({
      requests: texts.map((text) => ({
        content: { role: "user" as const, parts: [{ text }] },
        taskType: TaskType.RETRIEVAL_DOCUMENT,
      })),
    });
    return result.embeddings.map((e) => e.values);
  }

  async embedQuery(text: string): Promise<number[]> {
    const model = this.genAI.getGenerativeModel({ model: this.modelName });
    const result = await model.embedContent({
      content: { role: "user" as const, parts: [{ text }] },
      taskType: TaskType.RETRIEVAL_QUERY,
    });
    return result.embedding.values;
  }
}

// ─── Factory ─────────────────────────────────────────────

let cachedEmbedder: Embedder | null = null;

export function getEmbedder(): Embedder {
  if (cachedEmbedder) return cachedEmbedder;

  const provider = (process.env.EMBEDDING_PROVIDER || "gemini") as EmbeddingProviderName;
  const model = process.env.EMBEDDING_MODEL || undefined;

  switch (provider) {
    case "openai":
      cachedEmbedder = new OpenAIEmbedder(model);
      break;
    case "gemini":
      cachedEmbedder = new GeminiEmbedder(model);
      break;
    default:
      throw new Error(
        `Unsupported EMBEDDING_PROVIDER: "${provider}". Must be "openai" or "gemini".`,
      );
  }

  return cachedEmbedder;
}

export function resetEmbedderCache(): void {
  cachedEmbedder = null;
}

/** Validate that the embedding provider's API key is configured */
export function validateEmbeddingKey(): string | null {
  const provider = (process.env.EMBEDDING_PROVIDER || "gemini") as EmbeddingProviderName;
  switch (provider) {
    case "openai":
      return process.env.OPENAI_API_KEY ? null : "OPENAI_API_KEY";
    case "gemini":
      return process.env.GOOGLE_API_KEY ? null : "GOOGLE_API_KEY";
    default:
      return `UNKNOWN_EMBEDDING_PROVIDER(${provider})`;
  }
}
