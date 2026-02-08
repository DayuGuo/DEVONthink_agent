/**
 * search.ts — Web search
 *
 * Search provider priority: Tavily > Brave Search (free) > Jina Search
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
}

export interface WebSearchResponse {
  query: string;
  results: SearchResult[];
  source: "tavily" | "brave" | "jina";
  error?: string;
}

/**
 * Perform a web search. Tries providers in priority order:
 * 1. TAVILY_API_KEY → Tavily (highest search quality, paid)
 * 2. BRAVE_API_KEY  → Brave Search (free 2000 req/month, recommended)
 * 3. JINA_API_KEY   → Jina Search
 * 4. None configured → return friendly error message
 */
export async function webSearch(
  query: string,
  maxResults: number = 5,
): Promise<WebSearchResponse> {
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (tavilyKey) {
    return searchViaTavily(query, maxResults, tavilyKey);
  }
  const braveKey = process.env.BRAVE_API_KEY;
  if (braveKey) {
    return searchViaBrave(query, maxResults, braveKey);
  }
  const jinaKey = process.env.JINA_API_KEY;
  if (jinaKey) {
    return searchViaJina(query, maxResults, jinaKey);
  }
  return {
    query,
    source: "brave",
    results: [],
    error:
      "No web search API key configured. Recommended: set BRAVE_API_KEY in .env (free 2000 req/month, https://brave.com/search/api/).",
  };
}

// ─── Tavily ──────────────────────────────────────────────

async function searchViaTavily(
  query: string,
  maxResults: number,
  apiKey: string,
): Promise<WebSearchResponse> {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      include_answer: false,
      search_depth: "basic",
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Tavily API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    results: Array<{
      title: string;
      url: string;
      content: string;
      score: number;
    }>;
  };

  return {
    query,
    source: "tavily",
    results: (data.results || []).map((r) => ({
      title: r.title || "",
      url: r.url || "",
      snippet: (r.content || "").slice(0, 500),
      score: r.score,
    })),
  };
}

// ─── Brave Search (recommended free option) ──────────────

async function searchViaBrave(
  query: string,
  maxResults: number,
  apiKey: string,
): Promise<WebSearchResponse> {
  const params = new URLSearchParams({
    q: query,
    count: String(Math.min(maxResults, 20)),
  });

  const response = await fetch(
    `https://api.search.brave.com/res/v1/web/search?${params}`,
    {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
      signal: AbortSignal.timeout(15_000),
    },
  );

  if (!response.ok) {
    throw new Error(`Brave Search error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    web?: {
      results: Array<{
        title: string;
        url: string;
        description: string;
        extra_snippets?: string[];
      }>;
    };
  };

  const items = data.web?.results || [];
  return {
    query,
    source: "brave",
    results: items.slice(0, maxResults).map((r) => ({
      title: r.title || "",
      url: r.url || "",
      snippet: (
        r.description + (r.extra_snippets ? "\n" + r.extra_snippets.join("\n") : "")
      ).slice(0, 500),
    })),
  };
}

// ─── Jina Search ─────────────────────────────────────────

async function searchViaJina(
  query: string,
  maxResults: number,
  apiKey: string,
): Promise<WebSearchResponse> {
  const encodedQuery = encodeURIComponent(query);
  const response = await fetch(`https://s.jina.ai/${encodedQuery}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-Retain-Images": "none",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Jina Search error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    data: Array<{
      title: string;
      url: string;
      description: string;
      content?: string;
    }>;
  };

  const items = (data.data || []).slice(0, maxResults);
  return {
    query,
    source: "jina",
    results: items.map((r) => ({
      title: r.title || "",
      url: r.url || "",
      snippet: (r.description || r.content || "").slice(0, 500),
    })),
  };
}
