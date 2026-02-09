/**
 * store.ts — Local vector storage with binary format
 *
 * Stores embeddings in binary (Float32Array) for space efficiency,
 * with chunk metadata in a separate JSON file.
 *
 * Storage layout:
 *   ~/.dt-agent/index/
 *   ├── vectors.bin     # Binary: contiguous Float32 arrays
 *   ├── chunks.json     # JSON: chunk metadata (text, uuid, docName, etc.)
 *   └── meta.json       # JSON: index-level metadata (dimensions, document tracking)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

// ─── Paths ───────────────────────────────────────────────

const INDEX_DIR = resolve(homedir(), ".dt-agent", "index");
const VECTORS_PATH = resolve(INDEX_DIR, "vectors.bin");
const CHUNKS_PATH = resolve(INDEX_DIR, "chunks.json");
const META_PATH = resolve(INDEX_DIR, "meta.json");

// ─── Types ───────────────────────────────────────────────

export interface ChunkMeta {
  id: string;
  uuid: string;
  docName: string;
  database: string;
  text: string;
  chunkIndex: number;
}

export interface IndexMeta {
  version: number;
  embeddingProvider: string;
  embeddingModel: string;
  dimensions: number;
  totalChunks: number;
  totalDocuments: number;
  lastUpdated: string;
  /** Per-document tracking for incremental updates */
  documents: Record<
    string,
    {
      name: string;
      modificationDate: string;
      chunkCount: number;
    }
  >;
}

export interface SearchResult {
  uuid: string;
  docName: string;
  database: string;
  text: string;
  chunkIndex: number;
  score: number;
}

// ─── VectorStore ─────────────────────────────────────────

export class VectorStore {
  private chunks: ChunkMeta[] = [];
  private vectors: Float32Array = new Float32Array(0);
  private vectorsUsed = 0;
  private meta: IndexMeta;
  private dimensions: number;
  private loaded = false;

  constructor(dimensions: number, provider?: string, model?: string) {
    this.dimensions = dimensions;
    this.meta = {
      version: 1,
      embeddingProvider: provider || "unknown",
      embeddingModel: model || "unknown",
      dimensions,
      totalChunks: 0,
      totalDocuments: 0,
      lastUpdated: new Date().toISOString(),
      documents: {},
    };
  }

  /** Load index from disk. Returns false if no index exists or is unreadable. */
  load(): boolean {
    if (!existsSync(META_PATH)) return false;

    try {
      this.meta = JSON.parse(readFileSync(META_PATH, "utf-8"));
      this.dimensions = this.meta.dimensions;

      if (existsSync(CHUNKS_PATH)) {
        this.chunks = JSON.parse(readFileSync(CHUNKS_PATH, "utf-8"));
      }

      if (existsSync(VECTORS_PATH)) {
        const buf = readFileSync(VECTORS_PATH);
        // Copy to aligned ArrayBuffer for safe Float32Array creation
        const ab = new ArrayBuffer(buf.length);
        new Uint8Array(ab).set(buf);
        this.vectors = new Float32Array(ab);
        this.vectorsUsed = this.vectors.length;
      }

      this.loaded = true;
      return true;
    } catch {
      return false;
    }
  }

  /** Save index to disk */
  save(): void {
    mkdirSync(INDEX_DIR, { recursive: true });

    // Update meta counters
    this.meta.totalChunks = this.chunks.length;
    this.meta.totalDocuments = Object.keys(this.meta.documents).length;
    this.meta.lastUpdated = new Date().toISOString();
    this.meta.dimensions = this.dimensions;

    // Write only the used portion of vectors as binary Float32
    const usedBytes = this.vectorsUsed * Float32Array.BYTES_PER_ELEMENT;
    writeFileSync(
      VECTORS_PATH,
      Buffer.from(this.vectors.buffer, 0, usedBytes),
    );

    // Write chunks as JSON (no vectors — they're in the binary file)
    writeFileSync(CHUNKS_PATH, JSON.stringify(this.chunks));

    // Write meta as formatted JSON
    writeFileSync(META_PATH, JSON.stringify(this.meta, null, 2));
  }

  /** Semantic search: find top-K most similar chunks by cosine similarity */
  search(queryVector: number[], topK: number = 10): SearchResult[] {
    if (this.chunks.length === 0) return [];

    const scores: Array<{ index: number; score: number }> = [];
    for (let i = 0; i < this.chunks.length; i++) {
      const offset = i * this.dimensions;
      const score = cosineSimilarity(queryVector, this.vectors, offset, this.dimensions);
      scores.push({ index: i, score });
    }

    scores.sort((a, b) => b.score - a.score);

    return scores.slice(0, topK).map((s) => {
      const chunk = this.chunks[s.index];
      return {
        uuid: chunk.uuid,
        docName: chunk.docName,
        database: chunk.database,
        text: chunk.text,
        chunkIndex: chunk.chunkIndex,
        score: s.score,
      };
    });
  }

  /** Check if a document needs re-indexing based on modification date */
  needsReindex(uuid: string, modificationDate: string): boolean {
    const doc = this.meta.documents[uuid];
    return !doc || doc.modificationDate !== modificationDate;
  }

  /** Add or replace a document's chunks in the store */
  upsertDocument(
    uuid: string,
    name: string,
    modificationDate: string,
    newChunks: ChunkMeta[],
    newVectors: number[][],
  ): void {
    // Remove old chunks for this document (if any)
    this.removeDocument(uuid);

    // Append new chunks metadata
    this.chunks.push(...newChunks);

    // Append new vectors with amortized growth (O(n) total instead of O(n²))
    const addLength = newVectors.length * this.dimensions;
    const needed = this.vectorsUsed + addLength;
    if (needed > this.vectors.length) {
      // Double capacity or use needed size, whichever is larger
      const newCapacity = Math.max(needed, this.vectors.length * 2, 4096);
      const expanded = new Float32Array(newCapacity);
      if (this.vectorsUsed > 0) {
        expanded.set(this.vectors.subarray(0, this.vectorsUsed));
      }
      this.vectors = expanded;
    }
    for (let i = 0; i < newVectors.length; i++) {
      const offset = this.vectorsUsed + i * this.dimensions;
      for (let d = 0; d < this.dimensions; d++) {
        this.vectors[offset + d] = newVectors[i][d];
      }
    }
    this.vectorsUsed += addLength;

    // Update document tracking
    this.meta.documents[uuid] = {
      name,
      modificationDate,
      chunkCount: newChunks.length,
    };
  }

  /** Remove all chunks for a document */
  removeDocument(uuid: string): void {
    const removeIndices = new Set<number>();
    this.chunks.forEach((c, i) => {
      if (c.uuid === uuid) removeIndices.add(i);
    });

    if (removeIndices.size === 0) return;

    // Filter chunks and compact vectors in-place (no reallocation)
    const newChunks: ChunkMeta[] = [];
    const keepIndices: number[] = [];
    this.chunks.forEach((c, i) => {
      if (!removeIndices.has(i)) {
        newChunks.push(c);
        keepIndices.push(i);
      }
    });

    // Compact vectors in-place to avoid unnecessary memory allocation
    let writePos = 0;
    for (const oldIdx of keepIndices) {
      const src = oldIdx * this.dimensions;
      const dst = writePos * this.dimensions;
      if (src !== dst) {
        for (let d = 0; d < this.dimensions; d++) {
          this.vectors[dst + d] = this.vectors[src + d];
        }
      }
      writePos++;
    }

    this.chunks = newChunks;
    this.vectorsUsed = keepIndices.length * this.dimensions;
    delete this.meta.documents[uuid];
  }

  /** Get a copy of the index metadata */
  getMeta(): IndexMeta {
    return { ...this.meta };
  }

  /** Check if index is loaded and contains data */
  isReady(): boolean {
    return this.loaded && this.chunks.length > 0;
  }

  /** Total number of chunks in the store */
  get totalChunks(): number {
    return this.chunks.length;
  }
}

// ─── Cosine Similarity ───────────────────────────────────

/**
 * Compute cosine similarity between a query vector (plain array)
 * and a stored vector within a contiguous Float32Array.
 */
function cosineSimilarity(
  query: number[],
  stored: Float32Array,
  offset: number,
  dims: number,
): number {
  let dot = 0;
  let normQ = 0;
  let normS = 0;
  for (let i = 0; i < dims; i++) {
    const q = query[i];
    const s = stored[offset + i];
    dot += q * s;
    normQ += q * q;
    normS += s * s;
  }
  const denom = Math.sqrt(normQ) * Math.sqrt(normS);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Utilities ───────────────────────────────────────────

/** Check if an index exists on disk */
export function indexExists(): boolean {
  return existsSync(META_PATH) && existsSync(VECTORS_PATH);
}

/** Get index directory path */
export function getIndexDir(): string {
  return INDEX_DIR;
}
