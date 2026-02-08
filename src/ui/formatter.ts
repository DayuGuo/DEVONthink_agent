/**
 * formatter.ts — Tool result formatting
 *
 * Converts tool JSON results into human-readable summaries for terminal display.
 */

import chalk from "chalk";

/**
 * Format tool call arguments into a concise one-line description.
 */
export function formatToolInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    // DEVONthink
    case "search_records": {
      const db = input.database ? ` in "${input.database}"` : "";
      return `"${input.query}"${db}`;
    }
    case "get_record_content":
      return truncateUuid(input.uuid as string);
    case "get_record_metadata":
      return truncateUuid(input.uuid as string);
    case "list_databases":
      return "";
    case "list_group_contents":
      return input.uuid ? truncateUuid(input.uuid as string) : "root";
    case "get_related_records":
      return truncateUuid(input.uuid as string);
    case "classify_record":
      return truncateUuid(input.uuid as string);
    // Hybrid / Semantic Search
    case "hybrid_search": {
      const hDb = input.database ? ` in "${input.database}"` : "";
      return `"${input.query}"${hDb}`;
    }
    case "semantic_search":
      return `"${input.query}"`;
    // Web
    case "web_search":
      return `"${input.query}"`;
    case "fetch_url":
      return truncateUrl(input.url as string);
    default:
      return JSON.stringify(input).slice(0, 60);
  }
}

/**
 * Format tool result into a concise one-line summary.
 */
export function formatToolResult(name: string, result: unknown): string {
  if (!result || typeof result !== "object") return String(result);
  const r = result as Record<string, unknown>;

  if (r.error) return chalk.red(`Error: ${r.error}`);

  switch (name) {
    // DEVONthink
    case "search_records": {
      const arr = result as Array<Record<string, unknown>>;
      if (Array.isArray(arr)) {
        return `Found ${arr.length} results`;
      }
      return "Search complete";
    }
    case "get_record_content": {
      const wc = r.wordCount || "?";
      const trunc = r.truncated ? " (truncated)" : "";
      const fmtMap: Record<string, string> = {
        html: "HTML",
        markdown: "Markdown",
        plain_text: "Plain Text",
        image: "Image",
      };
      const fmt = fmtMap[r.contentFormat as string] || r.contentFormat || "";
      const fmtTag = fmt ? ` [${fmt}]` : "";
      return `${r.name}${fmtTag} — ${wc} words${trunc}`;
    }
    case "get_record_metadata":
      return `${r.name} [${r.recordType}]`;
    case "list_databases": {
      const arr = result as Array<Record<string, unknown>>;
      if (Array.isArray(arr)) {
        return arr.map((d) => d.name).join(", ");
      }
      return "Listed";
    }
    case "list_group_contents": {
      const g = r as { parentName?: string; totalChildren?: number };
      return `${g.parentName}: ${g.totalChildren} items`;
    }
    case "get_related_records": {
      const arr = result as Array<Record<string, unknown>>;
      if (Array.isArray(arr)) return `${arr.length} related documents`;
      return "Lookup complete";
    }
    case "classify_record": {
      const arr = result as Array<Record<string, unknown>>;
      if (Array.isArray(arr) && arr.length > 0) {
        return `Suggested: ${arr[0].name}`;
      }
      return "No suggestion";
    }
    // Hybrid / Semantic Search
    case "hybrid_search": {
      const hr = r as {
        results?: Array<{ matchedBy?: string[] }>;
        searchPaths?: string[];
        indexAvailable?: boolean;
      };
      const count = hr.results?.length ?? 0;
      const paths = (hr.searchPaths || []).join("+");
      const idxTag = hr.indexAvailable ? "" : " (no index)";
      return `${count} results [${paths}]${idxTag}`;
    }
    case "semantic_search": {
      const sr = r as {
        results?: Array<unknown>;
        indexAvailable?: boolean;
      };
      if (!sr.indexAvailable) return chalk.yellow("No semantic index — run /index first");
      return `${sr.results?.length ?? 0} results`;
    }
    // Web
    case "web_search": {
      const ws = r as {
        results?: Array<Record<string, unknown>>;
        source?: string;
        error?: string;
      };
      if (ws.error) return chalk.yellow(ws.error);
      const count = ws.results?.length ?? 0;
      const srcMap: Record<string, string> = {
        tavily: "Tavily",
        brave: "Brave",
        jina: "Jina",
      };
      const src = srcMap[ws.source || ""] || ws.source || "Web";
      return `${count} results (${src})`;
    }
    case "fetch_url": {
      const trunc = r.truncated ? " (truncated)" : "";
      return `${r.title || r.url}${trunc}`;
    }
    default:
      return JSON.stringify(result).slice(0, 80);
  }
}

function truncateUuid(uuid: string): string {
  if (!uuid) return "??";
  return uuid.length > 8 ? uuid.slice(0, 8) + "…" : uuid;
}

function truncateUrl(url: string): string {
  if (!url) return "??";
  try {
    const u = new URL(url);
    const path = u.pathname.length > 20 ? u.pathname.slice(0, 20) + "…" : u.pathname;
    return u.hostname + path;
  } catch {
    return url.slice(0, 40);
  }
}
