# DEVONthink Agent

AI-powered CLI that lets you search, read, and analyze your [DEVONthink](https://www.devontechnologies.com/apps/devonthink) databases with natural language — powered by Claude, GPT, or Gemini.

> ⚠️ **Notice**: This is experimental software — do not use it in production environments. If you encounter any errors, please let me know and I'll try to fix them.
>
> **Read-only by design** — your data is never modified.

Demo: https://github.com/DayuGuo/DEVONthink_agent/blob/main/testvideo.gif

Related Blog：https://anotherdayu.com/2026/7710/

## Highlights

- **Hybrid RAG Search** — keyword + semantic + DEVONthink AI ("See Also"), fused & ranked
- **Multi-LLM** — Anthropic / OpenAI / Gemini, hot-swap with `/model`
- **Streaming** — real-time token-by-token output with cost tracking
- **Research Mode** — `/expand` runs a 3-phase survey → web → structured report
- **Cross-lingual** — semantic search finds conceptual matches across languages

## Requirements

- macOS with [DEVONthink 3/4](https://www.devontechnologies.com/apps/devonthink) (Pro or Server)
- [Node.js](https://nodejs.org/) ≥ 20
- API key for at least one LLM provider (Anthropic / OpenAI / Google Gemini)

## Quick Start

```bash
git clone https://github.com/DayuGuo/DEVONthink_agent.git
cd DEVONthink_agent
npm install
cp .env.example .env   # Edit: add your API key
npm run build && npm start
```

Optional — install as global command:

```bash
npm link
dt-agent "find all PDFs about machine learning"
```

## Configuration (.env)

```bash
# Choose one provider + set its key
LLM_PROVIDER=gemini                  # anthropic | openai | gemini
GEMINI_API_KEY=AIza...
# ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...

# Embedding (for semantic search index)
EMBEDDING_PROVIDER=gemini            # gemini | openai
EMBEDDING_MODEL=gemini-embedding-001 # or text-embedding-3-small

# Web search (optional, for /expand)
BRAVE_API_KEY=BSA...
# TAVILY_API_KEY=tvly-...
# JINA_API_KEY=jina_...

# Tuning (optional)
EMBED_BATCH_SIZE=20       # Vectors per API call
EMBED_BATCH_DELAY=300     # ms between batches
MAX_SEARCH_RESULTS=25     # Hybrid search results
```

## Commands

| Command | Description |
|---|---|
| `/index` | Build / update semantic search index |
| `/model` | Switch LLM provider or model |
| `/expand <topic>` | Research expansion (survey → web → report) |
| `/export` | Save last response as Markdown |
| `/compact` | Compress conversation to save context |
| `/usage` | Token & cost breakdown |
| `/version` | Check for updates |
| `/clear` | Reset conversation |
| `/quit` | Exit |

## Semantic Index

Build the index to enable the semantic search path in hybrid search:

```bash
/index              # Build or update
/index Notebook     # Index a specific database
/index --force      # Full rebuild
/index --status     # Check stats
```

Index is stored at `~/.dt-agent/index/` in binary format.

Without an index, hybrid search still works using keyword + See Also (semantic path is skipped).

## How Hybrid Search Works

Each query runs three strategies in parallel:

| Path | Engine | Finds |
|---|---|---|
| Keyword | DEVONthink full-text | Exact term matches |
| Semantic | Gemini / OpenAI embeddings | Conceptual similarity, cross-lingual |
| See Also | DEVONthink AI | Structurally related documents |

Results are fused and ranked — documents found by multiple paths are boosted.

## Update

```bash
npm run update   # git pull + npm install + npm run build
```

Or check inside the app with `/version`.

## Uninstall

```bash
npm unlink              # Remove global commands
rm -rf ~/.dt-agent      # Remove index & cache
rm -rf DEVONthink_agent # Remove project
```

## Safety

All DEVONthink operations are **read-only** — no write, edit, move, or delete operations exist in the codebase. Your data is safe.

## License

MIT
