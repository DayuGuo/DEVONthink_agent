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

import { getEmbedder, type Embedder } from "./embedder.js";
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

/** Number of chunks to embed in one API call (configurable via EMBED_BATCH_SIZE env var) */
const EMBED_BATCH_SIZE = Number(process.env.EMBED_BATCH_SIZE) || 50;

/** Delay between embedding batches in ms (configurable via EMBED_BATCH_DELAY env var) */
const EMBED_BATCH_DELAY = Number(process.env.EMBED_BATCH_DELAY) || 100;

/** Log progress every N documents */
const PROGRESS_INTERVAL = 10;

/** Save index checkpoint every N documents (crash resilience for large databases) */
const SAVE_INTERVAL = 50;

/** Max retries for embedding API calls (handles rate limiting) */
const MAX_EMBED_RETRIES = 3;

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
  //    Per-database enumeration for robustness with large databases (6GB+)
  progress("Crawling DEVONthink databases...");

  type DTRecord = {
    uuid: string;
    name: string;
    recordType: string;
    database: string;
    modificationDate: string;
  };
  let allRecords: DTRecord[] = [];

  if (database) {
    // Single database specified by user
    allRecords = await dt.listAllRecords(database);
    progress(`Found ${allRecords.length} documents in "${database}"`);
  } else {
    // Enumerate each database separately to avoid timeout/buffer limits
    const databases = (await dt.listDatabases()) as Array<{
      name: string;
      recordCount: number;
    }>;
    progress(`Found ${databases.length} database(s), scanning each...`);
    for (const db of databases) {
      try {
        progress(`  Scanning "${db.name}" (~${db.recordCount} records)...`);
        const records = await dt.listAllRecords(db.name);
        allRecords.push(...records);
        progress(`  "${db.name}": ${records.length} indexable documents`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        progress(
          `  Warning: failed to scan "${db.name}": ${msg.slice(0, 120)}`,
        );
      }
    }
    progress(
      `Total: ${allRecords.length} documents across ${databases.length} database(s)`,
    );
  }

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
  //    With intermediate saves for crash resilience and progress tracking
  let indexed = 0;
  let totalNewChunks = 0;
  let errors = 0;
  let lastSaveAt = 0;

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

      // Embed chunks in batches with retry logic for API resilience
      const allVectors: number[][] = [];
      for (let b = 0; b < chunks.length; b += EMBED_BATCH_SIZE) {
        const batch = chunks.slice(b, b + EMBED_BATCH_SIZE);
        const texts = batch.map((c) => c.text);
        const vectors = await embedWithRetry(embedder, texts);
        allVectors.push(...vectors);

        // Delay between batches to avoid rate limiting
        if (b + EMBED_BATCH_SIZE < chunks.length) {
          await new Promise((r) => setTimeout(r, EMBED_BATCH_DELAY));
        }
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

      // Periodic progress update with percentage and elapsed time
      if ((i + 1) % PROGRESS_INTERVAL === 0 || i === toIndex.length - 1) {
        const pct = Math.round(((i + 1) / toIndex.length) * 100);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        progress(
          `[${pct}%] Indexed ${indexed}/${toIndex.length} docs (${totalNewChunks} chunks, ${elapsed}s elapsed)`,
        );
      }

      // Intermediate save for crash resilience (every SAVE_INTERVAL documents)
      if (indexed - lastSaveAt >= SAVE_INTERVAL) {
        progress(`Saving checkpoint (${indexed} docs indexed so far)...`);
        store.save();
        lastSaveAt = indexed;
      }
    } catch (err: unknown) {
      errors++;
      const msg = err instanceof Error ? err.message : String(err);
      progress(`Warning: error indexing "${record.name}": ${msg.slice(0, 120)}`);
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

// ─── Helpers ─────────────────────────────────────────────

/**
 * Embed texts with exponential backoff retry.
 * Handles API rate limits (429) and transient errors for large indexing runs.
 */
async function embedWithRetry(
  embedder: Embedder,
  texts: string[],
  maxRetries: number = MAX_EMBED_RETRIES,
): Promise<number[][]> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await embedder.embedBatch(texts);
    } catch (err: unknown) {
      if (attempt === maxRetries) throw err;
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 15000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("embedWithRetry: unreachable");
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
