/**
 * index-manager.ts — Semantic search index orchestration
 *
 * Coordinates the full indexing pipeline:
 *   1. Crawl DEVONthink databases (list all document metadata)
 *   2. Identify documents that need (re-)indexing
 *   3. Read document content → chunk text → embed via API → store vectors
 *
 * Supports incremental updates: only re-indexes documents whose
 * modificationDate has changed since last indexing.
 */

import { getEmbedder } from "./embedder.js";
import { chunkDocument, type DocumentInput } from "./chunker.js";
import { VectorStore, indexExists, type IndexMeta, type ChunkMeta } from "./store.js";
import * as dt from "../bridge/devonthink.js";

// ─── Types ───────────────────────────────────────────────

export interface IndexOptions {
  /** Limit to a specific database */
  database?: string;
  /** Force full rebuild (ignore modification dates) */
  force?: boolean;
  /** Progress callback for UI updates */
  onProgress?: (message: string) => void;
}

export interface IndexStats {
  totalDocuments: number;
  indexedDocuments: number;
  totalChunks: number;
  skippedDocuments: number;
  errors: number;
  durationMs: number;
}

/** Content returned by DEVONthink getRecordContent JXA */
interface RecordContent {
  uuid?: string;
  name?: string;
  content?: string;
  error?: string;
}

// ─── Configuration ───────────────────────────────────────

/** Max characters to read per document for indexing */
const INDEX_CONTENT_MAX_LENGTH = 32000;

/** Number of chunks to embed in one API call */
const EMBED_BATCH_SIZE = 50;

/** Log progress every N documents */
const PROGRESS_INTERVAL = 10;

// ─── Index Building ──────────────────────────────────────

/**
 * Build or update the semantic search index.
 *
 * @returns Statistics about the indexing run
 */
export async function buildIndex(options: IndexOptions = {}): Promise<IndexStats> {
  const { database, force, onProgress } = options;
  const startTime = Date.now();
  const progress = onProgress || (() => {});

  // 1. Initialize embedder
  const embedder = getEmbedder();
  progress(`Embedding: ${embedder.modelName} (${embedder.dimensions} dims)`);

  // 2. Load or create vector store
  const store = new VectorStore(
    embedder.dimensions,
    process.env.EMBEDDING_PROVIDER || "gemini",
    embedder.modelName,
  );
  if (!force) {
    store.load(); // Load existing index for incremental update
  }

  // 3. Crawl DEVONthink databases for document metadata
  progress("Crawling DEVONthink databases...");
  const allRecords = await dt.listAllRecords(database);
  progress(`Found ${allRecords.length} documents`);

  // 4. Filter to documents that need indexing
  const toIndex = force
    ? allRecords
    : allRecords.filter((r) => store.needsReindex(r.uuid, r.modificationDate));

  const skipped = allRecords.length - toIndex.length;
  progress(
    `${toIndex.length} documents to index` +
      (skipped > 0 ? ` (${skipped} up-to-date, skipped)` : ""),
  );

  if (toIndex.length === 0) {
    return {
      totalDocuments: allRecords.length,
      indexedDocuments: 0,
      totalChunks: store.totalChunks,
      skippedDocuments: skipped,
      errors: 0,
      durationMs: Date.now() - startTime,
    };
  }

  // 5. Process documents: read → chunk → embed → store
  let indexed = 0;
  let totalNewChunks = 0;
  let errors = 0;

  for (let i = 0; i < toIndex.length; i++) {
    const record = toIndex[i];

    try {
      // Read document content
      const raw = (await dt.getRecordContent(
        record.uuid,
        INDEX_CONTENT_MAX_LENGTH,
      )) as RecordContent;

      if (!raw || raw.error || !raw.content || raw.content.length < 50) {
        continue; // Skip documents with no meaningful content
      }

      // Chunk the document
      const docInput: DocumentInput = {
        uuid: record.uuid,
        name: record.name,
        database: record.database,
        content: raw.content,
      };
      const chunks = chunkDocument(docInput);
      if (chunks.length === 0) continue;

      // Embed chunks in batches
      const allVectors: number[][] = [];
      for (let b = 0; b < chunks.length; b += EMBED_BATCH_SIZE) {
        const batch = chunks.slice(b, b + EMBED_BATCH_SIZE);
        const texts = batch.map((c) => c.text);
        const vectors = await embedder.embedBatch(texts);
        allVectors.push(...vectors);
      }

      // Store in vector store
      const chunkMetas: ChunkMeta[] = chunks.map((c) => ({
        id: c.id,
        uuid: c.uuid,
        docName: c.docName,
        database: c.database,
        text: c.text,
        chunkIndex: c.chunkIndex,
      }));

      store.upsertDocument(
        record.uuid,
        record.name,
        record.modificationDate,
        chunkMetas,
        allVectors,
      );

      indexed++;
      totalNewChunks += chunks.length;

      // Periodic progress update
      if ((i + 1) % PROGRESS_INTERVAL === 0 || i === toIndex.length - 1) {
        progress(`Indexed ${indexed}/${toIndex.length} docs (${totalNewChunks} chunks)`);
      }
    } catch (err: unknown) {
      errors++;
      const msg = err instanceof Error ? err.message : String(err);
      progress(`Warning: error indexing "${record.name}": ${msg.slice(0, 80)}`);
      // Continue — don't let one document failure stop the whole index
    }
  }

  // 6. Save index to disk
  progress("Saving index to disk...");
  store.save();

  const durationMs = Date.now() - startTime;
  progress(
    `Done! ${indexed} documents indexed, ${store.totalChunks} total chunks (${(durationMs / 1000).toFixed(1)}s)`,
  );

  return {
    totalDocuments: allRecords.length,
    indexedDocuments: indexed,
    totalChunks: store.totalChunks,
    skippedDocuments: skipped,
    errors,
    durationMs,
  };
}

/**
 * Get the current index status without building.
 */
export function getIndexStatus(): IndexMeta | null {
  if (!indexExists()) return null;
  try {
    const store = new VectorStore(0);
    if (store.load()) {
      return store.getMeta();
    }
  } catch {
    // Index corrupted or unreadable
  }
  return null;
}
