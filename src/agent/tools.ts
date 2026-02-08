/**
 * tools.ts — Tool definitions (provider-agnostic JSON Schema format)
 *
 * Tools are divided into two categories:
 * 1. DEVONthink read-only tools — search, read, browse databases (no data modification)
 * 2. Web tools — web search and webpage content retrieval
 *
 * Note: This Agent has strictly read-only access to DEVONthink databases.
 * No write/modify/move operations are provided.
 */

import * as dt from "../bridge/devonthink.js";
import { webSearch } from "../web/search.js";
import { fetchUrl } from "../web/fetch.js";
import { hybridSearch, semanticSearchOnly } from "../rag/hybrid-search.js";
import type { ToolDefinition } from "./providers.js";

type ToolDef = ToolDefinition;

// ━━━ DEVONthink Read-Only Tools ━━━━━━━━━━━━━━━━━━━━━━━━━

const searchRecords: ToolDef = {
  name: "search_records",
  description:
    "Full-text search documents in the DEVONthink database. Supports keywords, phrases, boolean operators (AND/OR/NOT), and search prefixes (name:, kind:, tags:, date:). Returns a list of matching documents with UUID, name, relevance score, type, tags, etc.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query string",
      },
      database: {
        type: "string",
        description:
          "Limit search to a specific database (by name); leave empty to search all",
      },
      limit: {
        type: "number",
        description: "Maximum number of results (default 20)",
      },
    },
    required: ["query"],
  },
};

const getRecordContent: ToolDef = {
  name: "get_record_content",
  description:
    "Read DEVONthink document content by UUID. Intelligently selects the best extraction method based on document type: HTML/Webarchive → preserves HTML structure (headings, links, tables); Markdown → preserves original syntax; PDF/Word/PPT → extracts plain text. Returns content with recordType and contentFormat fields indicating the format. Image files cannot have text extracted but will return the file path.",
  input_schema: {
    type: "object",
    properties: {
      uuid: {
        type: "string",
        description: "Record UUID",
      },
      max_length: {
        type: "number",
        description: "Maximum characters to return (default 16000)",
      },
    },
    required: ["uuid"],
  },
};

const getRecordMetadata: ToolDef = {
  name: "get_record_metadata",
  description:
    "Read complete metadata of a record: name, type, tags, rating, URL, comment, creation/modification dates, size, word count, custom metadata, etc. Does not include body content.",
  input_schema: {
    type: "object",
    properties: {
      uuid: {
        type: "string",
        description: "Record UUID",
      },
    },
    required: ["uuid"],
  },
};

const listDatabases: ToolDef = {
  name: "list_databases",
  description:
    "List all currently open databases in DEVONthink, returning name, UUID, and total record count. Typically the first step for the Agent to understand the user's data landscape.",
  input_schema: {
    type: "object",
    properties: {},
  },
};

const listGroupContents: ToolDef = {
  name: "list_group_contents",
  description:
    "List the direct children of a group (folder), returning UUID, name, type, and size for each child. Used for browsing database structure. If no UUID is provided, lists the current database root directory.",
  input_schema: {
    type: "object",
    properties: {
      uuid: {
        type: "string",
        description: "Group UUID; leave empty to list root directory",
      },
      limit: {
        type: "number",
        description: "Maximum number of results (default 30)",
      },
    },
  },
};

const getRelatedRecords: ToolDef = {
  name: "get_related_records",
  description:
    'Use DEVONthink\'s built-in AI (See Also) to find other documents similar in content to a specified document. Useful for discovering "hidden" connections between documents.',
  input_schema: {
    type: "object",
    properties: {
      uuid: {
        type: "string",
        description: "Source document UUID",
      },
      limit: {
        type: "number",
        description: "Maximum number of results (default 10)",
      },
    },
    required: ["uuid"],
  },
};

const classifyRecord: ToolDef = {
  name: "classify_record",
  description:
    "Use DEVONthink's built-in AI to analyze which group a document should be filed into. Returns up to 5 recommended groups with confidence scores. (Read-only analysis; does not actually move the document)",
  input_schema: {
    type: "object",
    properties: {
      uuid: { type: "string", description: "Record UUID" },
    },
    required: ["uuid"],
  },
};

// ━━━ Hybrid / Semantic Search Tools ━━━━━━━━━━━━━━━━━━━━━━

const hybridSearchTool: ToolDef = {
  name: "hybrid_search",
  description:
    "Primary search tool — combines three search strategies into one unified ranked result: " +
    "(1) DEVONthink keyword search for exact matches, " +
    "(2) semantic vector search for conceptual/cross-lingual matches, " +
    "(3) DEVONthink AI 'See Also' for hidden connections. " +
    "Results show which paths matched each document. Documents matched by multiple paths are more likely relevant. " +
    "If the semantic index is not built yet, automatically degrades to keyword + See Also (two-path). " +
    "Use this as your DEFAULT search tool for most queries.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query (natural language or keywords)",
      },
      database: {
        type: "string",
        description: "Limit search to a specific database name (optional)",
      },
      top_k: {
        type: "number",
        description: "Max results to return (default 10)",
      },
    },
    required: ["query"],
  },
};

const semanticSearchTool: ToolDef = {
  name: "semantic_search",
  description:
    "Pure semantic vector search — finds documents by meaning similarity, not keyword matching. " +
    "Best for: conceptual queries, cross-lingual discovery (Chinese query → English docs), " +
    "finding documents that discuss similar topics with completely different terminology. " +
    "Requires the index to be built (/index command). Returns relevant text snippets with similarity scores. " +
    "Use this when you specifically need conceptual search or when keyword search returns no results.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural language description of what you are looking for",
      },
      top_k: {
        type: "number",
        description: "Number of results to return (default 10)",
      },
    },
    required: ["query"],
  },
};

// ━━━ Web Tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const webSearchTool: ToolDef = {
  name: "web_search",
  description:
    "Search the internet for information. Returns a list of search results with title, URL, and snippet. Use to find the latest resources not in the database, supplement background knowledge, or verify information in the database.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search keywords or question",
      },
      max_results: {
        type: "number",
        description: "Maximum number of results (default 5)",
      },
    },
    required: ["query"],
  },
};

const fetchUrlTool: ToolDef = {
  name: "fetch_url",
  description:
    "Fetch the content of a specified URL and convert it to plain text. Use after web_search finds a valuable link to read its full content in depth.",
  input_schema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The webpage URL to fetch",
      },
      max_length: {
        type: "number",
        description: "Maximum characters to return (default 8000)",
      },
    },
    required: ["url"],
  },
};

// ━━━ Tool Registry ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** DEVONthink read-only tools */
const DT_TOOLS: ToolDef[] = [
  searchRecords,
  getRecordContent,
  getRecordMetadata,
  listDatabases,
  listGroupContents,
  getRelatedRecords,
  classifyRecord,
];

/** Hybrid / semantic search tools */
const RAG_TOOLS: ToolDef[] = [hybridSearchTool, semanticSearchTool];

/** Web tools */
const WEB_TOOLS: ToolDef[] = [webSearchTool, fetchUrlTool];

/** Get all available tool definitions */
export function getToolDefinitions(): ToolDef[] {
  return [...DT_TOOLS, ...RAG_TOOLS, ...WEB_TOOLS];
}

/** Get all tool names (for UI display) */
export function getToolNames(): string[] {
  return getToolDefinitions().map((t) => t.name);
}

// ━━━ Tool Dispatcher ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Execute a tool by name with the given input parameters.
 * All DEVONthink tools are read-only.
 */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    // ─── DEVONthink Read-Only ───
    case "search_records":
      return dt.searchRecords(
        input.query as string,
        input.database as string | undefined,
        input.limit as number | undefined,
      );
    case "get_record_content":
      return dt.getRecordContent(
        input.uuid as string,
        input.max_length as number | undefined,
      );
    case "get_record_metadata":
      return dt.getRecordMetadata(input.uuid as string);
    case "list_databases":
      return dt.listDatabases();
    case "list_group_contents":
      return dt.listGroupContents(
        input.uuid as string | undefined,
        input.limit as number | undefined,
      );
    case "get_related_records":
      return dt.getRelatedRecords(
        input.uuid as string,
        input.limit as number | undefined,
      );
    case "classify_record":
      return dt.classifyRecord(input.uuid as string);

    // ─── Hybrid / Semantic Search ───
    case "hybrid_search":
      return hybridSearch(input.query as string, {
        database: input.database as string | undefined,
        topK: input.top_k as number | undefined,
      });
    case "semantic_search":
      return semanticSearchOnly(input.query as string, input.top_k as number | undefined);

    // ─── Web ───
    case "web_search":
      return webSearch(input.query as string, input.max_results as number | undefined);
    case "fetch_url":
      return fetchUrl(input.url as string, input.max_length as number | undefined);

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
