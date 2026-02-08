# DEVONthink Agent AI

A terminal-based AI agent that connects to your [DEVONthink](https://www.devontechnologies.com/apps/devonthink) 4.2 databases on macOS, combining local knowledge with web search to deliver research-grade analysis — all without modifying a single file.

```
  ╔═══════════════════════════════════════════════╗
  ║       DEVONthink Agent AI  v0.2.0            ║
  ║    Claude / GPT / Gemini + JXA + Web         ║
  ╚═══════════════════════════════════════════════╝
```

## Why

DEVONthink is a powerful knowledge base, but querying it requires manual effort. This agent lets you **have a conversation with your data** — ask questions in natural language, and the AI will search your databases, read documents, find hidden connections, supplement with web research, and synthesize structured reports.

## Features

- **Streaming Output** — Real-time token-by-token response display, like ChatGPT. Text appears as the LLM generates it, not after a long wait.
- **Token Usage & Cost Tracking** — Every response shows input/output token counts, estimated cost, and cumulative session usage. Use `/usage` for a detailed breakdown.
- **Context Window Management** — Automatic context size monitoring with warnings when approaching model limits. Use `/compact` to trim history or `/clear` to start fresh.
- **Hybrid Search (RAG)** — Three-path fusion search combining DEVONthink keyword search, semantic vector search (Gemini/OpenAI embeddings), and DEVONthink AI "See Also" discovery. Finds documents by meaning, not just keywords — including cross-lingual matches.
- **Multi-LLM Support** — Choose between Anthropic Claude, OpenAI GPT, or Google Gemini as the AI brain. Switch models mid-conversation with `/model`.
- **DEVONthink Integration** — Full-text search, document reading (PDF/Word/PPT/HTML/Markdown), metadata inspection, folder browsing, AI-powered "See Also" for hidden connections, and classification suggestions — all via JXA (JavaScript for Automation).
- **Format-Aware Reading** — Intelligently extracts content based on document type: raw Markdown syntax, HTML structure preservation, plain text extraction from PDFs, etc.
- **Web Search** — Combines database knowledge with live internet search (Brave Search free tier / Tavily / Jina) and webpage content scraping.
- **Research Expansion Mode** — `/expand <topic>` triggers a deep research workflow: the agent surveys your existing materials, searches the web for gaps, discovers cross-disciplinary connections, and outputs a structured expansion report.
- **Markdown Export** — `/export` saves any agent response as a Markdown file for further use.
- **Update Checking** — Automatic check for new versions at startup. Use `/version` to manually check.
- **Strictly Read-Only** — Zero write operations. Your DEVONthink data is never modified, edited, or moved.
- **Retry & Error Handling** — Exponential backoff for transient LLM errors (429/5xx), graceful history recovery on failures.

## Requirements

- **macOS** (requires `osascript` for JXA)
- **DEVONthink 4.2+** (must be running)
- **Node.js ≥ 20**
- At least one LLM API key (Anthropic / OpenAI / Google)

## Quick Start

```bash
# Clone the repo
git clone https://github.com/your-username/DEVONthink_agent.git
cd DEVONthink_agent

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env — add your LLM API key and (optionally) a web search key

# Build
npm run build

# Run
npm start
```

### Global Command (optional)

```bash
npm link
```

Now you can launch from anywhere:

```bash
DEVONthink        # or: dt-agent
dt-agent --version
```

### Single Query Mode

```bash
dt-agent "What documents do I have about machine learning?"
```

## Configuration

All settings live in `.env`:

| Variable | Description | Default |
|---|---|---|
| `LLM_PROVIDER` | `anthropic` \| `openai` \| `gemini` | `anthropic` |
| `LLM_MODEL` | Model name (leave empty for provider default) | — |
| `ANTHROPIC_API_KEY` | Anthropic Claude API key | — |
| `OPENAI_API_KEY` | OpenAI API key | — |
| `GOOGLE_API_KEY` | Google Gemini API key | — |
| `EMBEDDING_PROVIDER` | Embedding for semantic search: `gemini` \| `openai` | `gemini` |
| `EMBEDDING_MODEL` | Embedding model (leave empty for default) | — |
| `BRAVE_API_KEY` | Brave Search (free 2000 req/month, **recommended**) | — |
| `TAVILY_API_KEY` | Tavily search (paid, higher quality) | — |
| `JINA_API_KEY` | Jina search + page scraping | — |
| `MAX_ITERATIONS` | Max agent reasoning loops per query | `25` |
| `MAX_TOKENS` | Max LLM output tokens | `4096` |
| `CONTENT_MAX_LENGTH` | Max characters when reading a document | `16000` |
| `JXA_TIMEOUT` | JXA script timeout in ms | `30000` |

### Default Models

| Provider | Default Model | Context Window |
|---|---|---|
| Anthropic | `claude-sonnet-4-20250514` | 200K |
| OpenAI | `gpt-4o` | 128K |
| Gemini | `gemini-2.5-flash` | 1M |

## Interactive Commands

| Command | Description |
|---|---|
| `/help` | Show help |
| `/model <provider> [model]` | Switch LLM (e.g. `/model gemini gemini-2.5-pro`) |
| `/tools` | List available tools |
| `/usage` | Show session token usage & estimated cost |
| `/compact` | Trim conversation history to save context window |
| `/clear` | Clear conversation history |
| `/index [database]` | Build/update semantic search index |
| `/index --force` | Force full index rebuild |
| `/index --status` | Show index statistics |
| `/expand <topic>` | Deep research expansion on a topic |
| `/export [filename]` | Export last response as Markdown |
| `/version` | Show version & check for updates |
| `/exit` | Exit |

## How It Works

```
┌──────────┐     ┌───────────┐     ┌──────────────┐
│  You      │────▶│  Agent    │────▶│  DEVONthink  │
│ (Terminal)│◀────│  (LLM)    │◀────│  (JXA Bridge) │
└──────────┘     │           │     └──────────────┘
                 │           │     ┌──────────────┐
                 │           │────▶│  Vector Index │
                 │           │◀────│  (Embeddings) │
                 │           │     └──────────────┘
                 │           │     ┌──────────────┐
                 │           │────▶│  Web Search   │
                 │           │◀────│  (Brave/etc.) │
                 └───────────┘     └──────────────┘
```

1. You type a question in the terminal.
2. The LLM (Claude/GPT/Gemini) decides which tools to use via a **ReAct loop**.
3. **Hybrid search** combines keyword search, vector similarity, and AI discovery.
4. Tools execute read-only JXA scripts against DEVONthink, query the local vector index, and/or run web searches.
5. Results feed back to the LLM for further reasoning or final synthesis.
6. The agent **streams** the response in real-time with token usage stats.

### Available Tools

| Tool | Description |
|---|---|
| `hybrid_search` | **Primary** — Three-path fusion: keyword + semantic + AI discovery |
| `semantic_search` | Pure vector similarity search (conceptual/cross-lingual) |
| `search_records` | DEVONthink keyword search with filters (kind:, tags:, date:) |
| `get_record_content` | Read document content (format-aware: HTML/Markdown/PDF/Word) |
| `get_record_metadata` | View tags, dates, ratings, custom metadata |
| `list_databases` | List all open databases |
| `list_group_contents` | Browse folder structure |
| `get_related_records` | DEVONthink AI "See Also" — find similar documents |
| `classify_record` | AI-powered filing suggestions |
| `web_search` | Internet search via Brave/Tavily/Jina |
| `fetch_url` | Fetch and extract webpage content |

## Streaming & Token Tracking

Responses are streamed in real-time — text appears token-by-token as the LLM generates it, giving immediate feedback instead of waiting for the full response.

After each response, a usage summary is displayed:

```
[gemini/gemini-2.5-flash · 3 iter · 5 tools · ↑12,450 ↓1,823 tokens · ~$0.0030 · session: 28,105]
```

- **↑** = input tokens (prompt + history + tool results)
- **↓** = output tokens (LLM response)
- **~$** = estimated cost based on model pricing
- **session** = cumulative total for the entire session

Use `/usage` for a detailed breakdown including context window limit.

When input tokens approach the model's context window limit (75%), a warning appears suggesting `/compact` or `/clear`.

### Supported Cost Tracking Models

| Model | Input ($/M) | Output ($/M) |
|---|---|---|
| Claude Sonnet 4 | $3.00 | $15.00 |
| GPT-4o | $2.50 | $10.00 |
| GPT-4o mini | $0.15 | $0.60 |
| Gemini 2.5 Flash | $0.15 | $0.60 |
| Gemini 2.5 Pro | $1.25 | $10.00 |

## Research Expansion Mode

The `/expand` command triggers a structured 3-phase research workflow:

```
/expand schistosomiasis ultrasound diagnosis
```

**Phase 1 — Survey**: Searches your database from multiple angles, reads key documents in depth, uses "See Also" to find hidden connections.

**Phase 2 — Web Exploration**: Based on what's in your database, constructs targeted web searches to find what's *missing* — latest developments, new methods, cross-disciplinary opportunities.

**Phase 3 — Structured Report**:
- **Your Materials Already Cover** — what you have, organized by sub-topic
- **Knowledge Gaps & Latest Developments** — what's new that you don't have
- **Cross-Disciplinary Connections** — non-obvious links between your materials and new findings
- **Suggested Exploration Directions** — specific, actionable next steps

Export the report with `/export` for future reference.

## Semantic Search / RAG

The agent includes a built-in RAG (Retrieval-Augmented Generation) system that adds semantic understanding to DEVONthink's keyword search.

### Building the Index

```bash
# Build/update the semantic search index
/index

# Index a specific database only
/index Notebook

# Force full rebuild
/index --force

# Check index status
/index --status
```

### How Hybrid Search Works

When you ask a question, `hybrid_search` runs three strategies in parallel:

| Path | Engine | Finds |
|---|---|---|
| **Keyword** | DEVONthink full-text | Exact term matches |
| **Semantic** | Gemini/OpenAI embeddings | Conceptually similar content, cross-lingual |
| **See Also** | DEVONthink AI | Structurally similar documents |

Results are merged with multi-path boosting — documents found by 2+ paths rank highest.

**Without the index**: hybrid search gracefully degrades to keyword + See Also (still very useful). The semantic path simply gets skipped.

### Storage

The index is stored locally at `~/.dt-agent/index/` using binary format (Float32 vectors + JSON metadata). Typical sizes:

| Documents | Gemini (768d) | OpenAI (1536d) |
|---|---|---|
| 1,000 | ~15 MB | ~25 MB |
| 5,000 | ~75 MB | ~130 MB |
| 10,000 | ~150 MB | ~260 MB |

## Project Structure

```
src/
├── index.ts                  # CLI entry point, interactive loop, streaming display
├── updater.ts                # Version management & GitHub update checking
├── agent/
│   ├── loop.ts               # ReAct agent loop with retry logic & usage tracking
│   ├── providers.ts          # LLM abstraction (Anthropic/OpenAI/Gemini) with streaming
│   ├── tools.ts              # Tool definitions & dispatcher
│   └── system-prompt.ts      # System prompts (general + expansion mode)
├── rag/
│   ├── embedder.ts           # Embedding API abstraction (OpenAI/Gemini)
│   ├── chunker.ts            # Document text chunking with overlap
│   ├── store.ts              # Binary vector storage + cosine similarity
│   ├── index-manager.ts      # Index build/update orchestration
│   └── hybrid-search.ts      # Three-path fusion search
├── bridge/
│   ├── devonthink.ts         # High-level DEVONthink API (read-only)
│   ├── executor.ts           # JXA script executor (osascript)
│   └── scripts/
│       ├── search.ts         # Search, See Also, Classify scripts
│       ├── records.ts        # Content & metadata extraction scripts
│       └── databases.ts      # Database & group browsing + record enumeration
├── web/
│   ├── search.ts             # Web search (Brave/Tavily/Jina)
│   └── fetch.ts              # URL content fetching
└── ui/
    ├── terminal.ts           # Terminal UI (readline, chalk, ora)
    └── formatter.ts          # Tool result formatting
```

## Development

```bash
# Run in dev mode (no build needed)
npm run dev

# Type check + lint + format check
npm run check

# Auto-fix lint & format
npm run lint:fix && npm run format
```

## Updating

Check for updates and apply them:

```bash
# Check version inside the app
/version

# Or from the command line
dt-agent --version

# Update to the latest version
npm run update
# This runs: git pull origin main && npm install && npm run build
```

The agent also checks for updates automatically at startup (once per 24 hours) and shows a notification if a new version is available.

## Uninstall

```bash
npm unlink              # Remove global commands
rm -rf ~/.dt-agent      # Remove semantic index & update cache
rm -rf DEVONthink_agent # Remove project
```

> Your DEVONthink databases are never modified — no cleanup needed on that side.

## Safety

This agent is designed with a **strict read-only policy**:

- All DEVONthink operations are read-only (search, read, browse, compare, classify).
- No write, edit, move, or delete operations exist in the codebase.
- Write-related JXA functions have been intentionally removed.
- Your data is safe.

## Changelog

### v0.2.0

- **Streaming output** — Real-time token-by-token display for all LLM providers
- **Token usage tracking** — Per-turn and session-level input/output token counts with cost estimation
- **Context window management** — Automatic warnings + `/compact` and `/usage` commands
- **Update mechanism** — `/version` command, `--version` flag, automatic startup update check via GitHub API
- **Logic fixes** — Safe `/compact` with message boundary detection, streaming retry indicator, defensive buffer writes

### v0.1.0

- Initial release
- Multi-LLM support (Anthropic / OpenAI / Gemini)
- DEVONthink read-only integration via JXA
- Hybrid search (RAG) with semantic vector index
- Web search (Brave / Tavily / Jina)
- Research expansion mode (`/expand`)
- Report export (`/export`)

## License

MIT
