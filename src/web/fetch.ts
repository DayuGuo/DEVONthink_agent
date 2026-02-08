/**
 * fetch.ts — Webpage content scraping
 *
 * Uses the Jina Reader API to convert any URL into clean, readable text.
 * Requires JINA_API_KEY for authentication; if no key is present,
 * falls back to direct fetch + HTML text extraction.
 */

export interface FetchedPage {
  url: string;
  title: string;
  content: string;
  truncated: boolean;
  totalLength: number;
}

/**
 * Fetch the content of a specified URL and convert it to plain text.
 *
 * Uses the Jina Reader API (r.jina.ai) for content extraction,
 * which is much more reliable than direct HTML fetch + regex cleaning.
 */
export async function fetchUrl(
  url: string,
  maxLength: number = 8000,
): Promise<FetchedPage> {
  const jinaKey = process.env.JINA_API_KEY;

  // If no Jina key, use fallback directly
  if (!jinaKey) {
    return fetchDirectFallback(url, maxLength);
  }

  const jinaUrl = `https://r.jina.ai/${url}`;

  const response = await fetch(jinaUrl, {
    headers: {
      Accept: "text/plain",
      Authorization: `Bearer ${jinaKey}`,
      "X-Retain-Images": "none",
      "X-Return-Format": "text",
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    // If Jina fails, fall back to direct fetch + basic text extraction
    return fetchDirectFallback(url, maxLength);
  }

  const text = await response.text();
  const totalLength = text.length;
  const truncated = totalLength > maxLength;
  const content = truncated ? text.slice(0, maxLength) : text;

  // Try to extract title from the first line of Jina's returned content
  const firstLine = content.split("\n")[0]?.trim() || "";
  const title = firstLine.startsWith("#")
    ? firstLine.replace(/^#+\s*/, "")
    : firstLine.slice(0, 100);

  return {
    url,
    title,
    content,
    truncated,
    totalLength,
  };
}

/**
 * Direct fetch fallback: fetches HTML and performs basic text extraction.
 */
async function fetchDirectFallback(url: string, maxLength: number): Promise<FetchedPage> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Apple M2 Pro) DTAgent/0.1",
      Accept: "text/html,text/plain,application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const raw = await response.text();

  let text: string;
  if (contentType.includes("text/html")) {
    text = extractTextFromHtml(raw);
  } else {
    text = raw;
  }

  const totalLength = text.length;
  const truncated = totalLength > maxLength;
  const content = truncated ? text.slice(0, maxLength) : text;

  // Extract title from HTML <title> tag
  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : url;

  return { url, title, content, truncated, totalLength };
}

/**
 * Extract plain text from HTML (simple implementation, no DOM library dependency).
 */
function extractTextFromHtml(html: string): string {
  return (
    html
      // Remove script / style / head
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<head[\s\S]*?<\/head>/gi, "")
      // Replace block elements with newlines
      .replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      // Remove all tags
      .replace(/<[^>]+>/g, " ")
      // Decode common HTML entities
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      // Clean up excess whitespace
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n/g, "\n\n")
      .trim()
  );
}
