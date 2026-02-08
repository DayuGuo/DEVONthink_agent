/**
 * hybrid-search.ts — Three-path fusion search
 *
 * Combines three search strategies into a unified ranked result:
 *   1. DEVONthink keyword search (search_records)
 *   2. Gemini/OpenAI semantic search (vector similarity)
 *   3. DEVONthink "See Also" AI (document-to-document similarity)
 *
 * Gracefully degrades: if no semantic index exists, uses two-path search.
 * If only keyword search is available, works as a single path.
 */

import { getEmbedder } from "./embedder.js";
import { VectorStore, indexExists } from "./store.js";
import * as dt from "../bridge/devonthink.js";

// ─── Types ───────────────────────────────────────────────

export interface HybridResult {
  uuid: string;
  name: string;
  database: string;
  recordType: string;
  /** Normalized score (0-1) */
  score: number;
  /** Which search paths matched this document */
  matchedBy: ("keyword" | "semantic" | "related")[];
  /** Relevant text snippet from semantic search (if matched) */
  semanticSnippet?: string;
}

export interface HybridSearchOptions {
  /** Limit keyword search to a specific database */
  database?: string;
  /** Max results to return (default 10) */
  topK?: number;
  /** Enable semantic search path (default true if index exists) */
  enableSemantic?: boolean;
  /** Enable See Also path (default true) */
  enableRelated?: boolean;
}

export interface HybridSearchResponse {
  results: HybridResult[];
  /** Which search paths were actually used */
  searchPaths: string[];
  /** Whether the semantic index is available */
  indexAvailable: boolean;
}

// ─── Score Normalization ─────────────────────────────────

/** DEVONthink search/See Also scores are typically 0-100+ */
function normalizeKeywordScore(score: number): number {
  return Math.min(1, Math.max(0, score / 100));
}

function normalizeRelatedScore(score: number): number {
  return Math.min(1, Math.max(0, score / 100));
}

/**
 * Cosine similarity is -1 to 1, but for text typically 0.3-0.95.
 * Map [0.4, 1.0] → [0, 1] for a more meaningful spread.
 */
function normalizeSemanticScore(score: number): number {
  return Math.max(0, Math.min(1, (score - 0.4) / 0.6));
}

// ─── Singleton Store Cache ───────────────────────────────

let cachedStore: VectorStore | null = null;

function getStore(): VectorStore | null {
  if (!indexExists()) return null;
  if (cachedStore?.isReady()) return cachedStore;

  const store = new VectorStore(0);
  if (store.load()) {
    cachedStore = store;
    return store;
  }
  return null;
}

/** Reset cached store (call after rebuilding index) */
export function resetStoreCache(): void {
  cachedStore = null;
}

// ─── Hybrid Search ───────────────────────────────────────

/**
 * Perform hybrid search combining up to three paths:
 * 1. DEVONthink keyword search (always)
 * 2. Semantic vector search (if index available)
 * 3. DEVONthink "See Also" (using top result as seed)
 */
export async function hybridSearch(
  query: string,
  options: HybridSearchOptions = {},
): Promise<HybridSearchResponse> {
  const topK = options.topK || 10;
  const results = new Map<string, HybridResult>();
  const searchPaths: string[] = [];

  // ═══ Path 1: DEVONthink keyword search ═══
  try {
    const keywordResults = (await dt.searchRecords(
      query,
      options.database,
      15,
    )) as Array<{
      uuid: string;
      name: string;
      score: number;
      recordType: string;
      database: string;
    }>;

    if (Array.isArray(keywordResults)) {
      searchPaths.push("keyword");
      for (const r of keywordResults) {
        results.set(r.uuid, {
          uuid: r.uuid,
          name: r.name,
          database: r.database,
          recordType: r.recordType,
          score: normalizeKeywordScore(r.score),
          matchedBy: ["keyword"],
        });
      }
    }
  } catch {
    // Keyword search failed — continue with other paths
  }

  // ═══ Path 2: Semantic search (if index available) ═══
  const semanticEnabled = options.enableSemantic !== false;
  const store = semanticEnabled ? getStore() : null;
  const indexAvailable = store !== null;

  if (store) {
    try {
      const embedder = getEmbedder();
      const queryVector = await embedder.embedQuery(query);
      const semanticResults = store.search(queryVector, 15);
      searchPaths.push("semantic");

      for (const sr of semanticResults) {
        const normalized = normalizeSemanticScore(sr.score);
        if (normalized < 0.1) continue; // Skip very low similarity

        const existing = results.get(sr.uuid);
        if (existing) {
          // Both paths hit this document — boost score
          existing.score = Math.min(1, existing.score + normalized * 0.5);
          existing.matchedBy.push("semantic");
          existing.semanticSnippet = sr.text.slice(0, 200);
        } else {
          results.set(sr.uuid, {
            uuid: sr.uuid,
            name: sr.docName,
            database: sr.database,
            recordType: "",
            score: normalized * 0.85,
            matchedBy: ["semantic"],
            semanticSnippet: sr.text.slice(0, 200),
          });
        }
      }
    } catch {
      // Semantic search failed — continue
    }
  }

  // ═══ Path 3: DEVONthink "See Also" ═══
  const relatedEnabled = options.enableRelated !== false;
  if (relatedEnabled && results.size > 0) {
    // Use the highest-scored document as seed
    const sorted = [...results.values()].sort((a, b) => b.score - a.score);
    const seed = sorted[0];

    try {
      const related = (await dt.getRelatedRecords(seed.uuid, 10)) as Array<{
        uuid: string;
        name: string;
        score: number;
        recordType: string;
        database: string;
      }>;

      if (Array.isArray(related)) {
        searchPaths.push("related");
        for (const r of related) {
          if (r.uuid === seed.uuid) continue; // Skip seed itself
          const normalized = normalizeRelatedScore(r.score);

          const existing = results.get(r.uuid);
          if (existing) {
            existing.score = Math.min(1, existing.score + 0.15);
            if (!existing.matchedBy.includes("related")) {
              existing.matchedBy.push("related");
            }
          } else {
            results.set(r.uuid, {
              uuid: r.uuid,
              name: r.name,
              database: r.database,
              recordType: r.recordType,
              score: normalized * 0.6,
              matchedBy: ["related"],
            });
          }
        }
      }
    } catch {
      // Related search failed — continue
    }
  }

  // ═══ Merge & Rank ═══
  const merged = [...results.values()]
    .sort((a, b) => {
      // Multi-path matches rank higher
      const pathDiff = b.matchedBy.length - a.matchedBy.length;
      if (pathDiff !== 0) return pathDiff;
      return b.score - a.score;
    })
    .slice(0, topK);

  return { results: merged, searchPaths, indexAvailable };
}

/**
 * Standalone semantic search (without keyword/related fusion).
 * Returns raw vector similarity results.
 */
export async function semanticSearchOnly(
  query: string,
  topK: number = 10,
): Promise<{
  results: Array<{
    uuid: string;
    docName: string;
    database: string;
    text: string;
    score: number;
  }>;
  indexAvailable: boolean;
}> {
  const store = getStore();
  if (!store) {
    return { results: [], indexAvailable: false };
  }

  const embedder = getEmbedder();
  const queryVector = await embedder.embedQuery(query);
  const results = store.search(queryVector, topK);

  return {
    results: results.map((r) => ({
      uuid: r.uuid,
      docName: r.docName,
      database: r.database,
      text: r.text,
      score: r.score,
    })),
    indexAvailable: true,
  };
}
