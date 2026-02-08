/**
 * chunker.ts — Document text chunking
 *
 * Splits document content into overlapping chunks suitable for embedding.
 * Strategy: paragraph-first splitting → sentence fallback → overlap between chunks.
 */

// ─── Types ───────────────────────────────────────────────

export interface ChunkData {
  /** Unique chunk ID: "{uuid}#{chunkIndex}" */
  id: string;
  /** Source document UUID */
  uuid: string;
  /** Source document name */
  docName: string;
  /** Source database name */
  database: string;
  /** Chunk text content */
  text: string;
  /** Chunk position in document (0-based) */
  chunkIndex: number;
}

export interface DocumentInput {
  uuid: string;
  name: string;
  database: string;
  content: string;
}

// ─── Configuration ───────────────────────────────────────

/** Target characters per chunk (~500 tokens) */
const CHUNK_MAX_CHARS = 2000;

/** Overlap characters between adjacent chunks (~100 tokens) */
const OVERLAP_CHARS = 400;

/** Minimum chunk length — skip very short chunks */
const MIN_CHUNK_CHARS = 100;

// ─── Main Chunking Function ─────────────────────────────

/**
 * Split a document into overlapping chunks.
 *
 * Strategy:
 * 1. Split by double newlines (paragraphs / headings)
 * 2. Merge short paragraphs into one chunk
 * 3. If a single paragraph exceeds CHUNK_MAX_CHARS, split by sentences
 * 4. Add overlap from previous chunk to maintain cross-chunk context
 */
export function chunkDocument(doc: DocumentInput): ChunkData[] {
  const text = doc.content.trim();
  if (text.length < MIN_CHUNK_CHARS) return [];

  // Step 1: Split into paragraph-level raw chunks
  const rawChunks = splitIntoParagraphChunks(text);

  // Step 2: Apply overlap between adjacent chunks
  const overlapped = applyOverlap(rawChunks);

  // Step 3: Convert to ChunkData with metadata
  return overlapped
    .filter((t) => t.length >= MIN_CHUNK_CHARS)
    .map((chunkText, i) => ({
      id: `${doc.uuid}#${i}`,
      uuid: doc.uuid,
      docName: doc.name,
      database: doc.database,
      text: chunkText,
      chunkIndex: i,
    }));
}

// ─── Internal Helpers ────────────────────────────────────

/**
 * Split text into chunks at paragraph boundaries.
 * Merges short paragraphs; splits long ones by sentences.
 */
function splitIntoParagraphChunks(text: string): string[] {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let buffer = "";

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    // If adding this paragraph stays within limit, merge
    if (buffer.length + trimmed.length + 2 <= CHUNK_MAX_CHARS) {
      buffer += (buffer ? "\n\n" : "") + trimmed;
    } else {
      // Flush current buffer
      if (buffer) chunks.push(buffer);

      // If single paragraph is too long, split by sentences
      if (trimmed.length > CHUNK_MAX_CHARS) {
        const sentenceChunks = splitBySentences(trimmed);
        chunks.push(...sentenceChunks);
        buffer = "";
      } else {
        buffer = trimmed;
      }
    }
  }

  if (buffer) chunks.push(buffer);
  return chunks;
}

/**
 * Split a long text by sentences, accumulating up to CHUNK_MAX_CHARS per group.
 */
function splitBySentences(text: string): string[] {
  // Split on sentence-ending punctuation followed by whitespace
  const sentences = text.split(/(?<=[.!?。！？；\n])\s+/);
  const chunks: string[] = [];
  let current = "";

  for (const sent of sentences) {
    if (current.length + sent.length + 1 <= CHUNK_MAX_CHARS) {
      current += (current ? " " : "") + sent;
    } else {
      if (current) chunks.push(current);
      // If a single sentence is too long, force-split by character limit
      if (sent.length > CHUNK_MAX_CHARS) {
        for (let i = 0; i < sent.length; i += CHUNK_MAX_CHARS) {
          chunks.push(sent.slice(i, i + CHUNK_MAX_CHARS));
        }
        current = "";
      } else {
        current = sent;
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

/**
 * Apply overlap: prepend tail of previous chunk to current chunk.
 * This ensures context is not lost at chunk boundaries.
 */
function applyOverlap(rawChunks: string[]): string[] {
  if (rawChunks.length <= 1) return rawChunks;

  const result: string[] = [rawChunks[0]];

  for (let i = 1; i < rawChunks.length; i++) {
    const prevTail = rawChunks[i - 1].slice(-OVERLAP_CHARS);
    const separator = prevTail.endsWith("\n") ? "" : "\n";
    const combined = prevTail + separator + rawChunks[i];
    // Cap at reasonable maximum to prevent oversized chunks
    const maxAllowed = CHUNK_MAX_CHARS + OVERLAP_CHARS;
    result.push(combined.length > maxAllowed ? combined.slice(0, maxAllowed) : combined);
  }

  return result;
}
