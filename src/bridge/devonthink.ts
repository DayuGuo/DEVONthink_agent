/**
 * devonthink.ts — DEVONthink high-level API (read-only)
 *
 * Each method corresponds to an Agent read-only tool.
 * Internally builds JXA scripts → calls executor → parses JSON response.
 *
 * Note: This module is strictly read-only. No methods that modify DEVONthink data are provided.
 */

import { runJXAJSON } from "./executor.js";
import { searchScript, getRelatedScript, classifyScript } from "./scripts/search.js";
import { getRecordContentScript, getRecordMetadataScript } from "./scripts/records.js";
import {
  listDatabasesScript,
  listGroupContentsScript,
  listAllRecordsScript,
} from "./scripts/databases.js";

// ─── Read-Only Operations ────────────────────────────────

export async function searchRecords(query: string, database?: string, limit?: number) {
  return runJXAJSON(searchScript(query, database, limit));
}

export async function getRecordContent(uuid: string, maxLength?: number) {
  // Support CONTENT_MAX_LENGTH env var for custom default truncation length
  const effectiveMax = maxLength ?? (Number(process.env.CONTENT_MAX_LENGTH) || undefined);
  return runJXAJSON(getRecordContentScript(uuid, effectiveMax));
}

export async function getRecordMetadata(uuid: string) {
  return runJXAJSON(getRecordMetadataScript(uuid));
}

export async function listDatabases() {
  return runJXAJSON(listDatabasesScript());
}

export async function listGroupContents(uuid?: string, limit?: number) {
  return runJXAJSON(listGroupContentsScript(uuid, limit));
}

export async function getRelatedRecords(uuid: string, limit?: number) {
  return runJXAJSON(getRelatedScript(uuid, limit));
}

export async function classifyRecord(uuid: string) {
  return runJXAJSON(classifyScript(uuid));
}

/**
 * List all document records in databases (metadata only, no content).
 * Used by the RAG indexer. Uses a longer timeout (60s) for large databases.
 */
export async function listAllRecords(database?: string) {
  return runJXAJSON<
    Array<{
      uuid: string;
      name: string;
      recordType: string;
      database: string;
      modificationDate: string;
      wordCount: number;
    }>
  >(listAllRecordsScript(database), 60_000);
}
