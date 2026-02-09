# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-02-08

### Fixed
- **Critical bug in Gemini provider**: Fixed incorrect message role type in `pushToolResults` method
  - Changed from `role: "function"` to `role: "user"` for function responses
  - This was causing repeated tool calls and duplicate content in conversations
  - Gemini API requires function responses to be sent with "user" role, not "function" role
  - Issue only affected users running with `LLM_PROVIDER=gemini`

### Technical Details
- File: `src/agent/providers.ts` line 536
- Impact: Gemini conversations with tool usage would exhibit:
  - Repeated invocations of the same tool
  - Duplicate or circular content in responses
  - Incorrect conversation state tracking

## [0.2.0] - 2026-02-07

### Added
- Initial public release
- Multi-LLM support: Anthropic Claude, OpenAI GPT, Google Gemini
- DEVONthink integration via JXA (read-only)
- Hybrid RAG search (keyword + semantic + AI discovery)
- Web search capabilities (Brave/Tavily/Jina)
- Streaming output with token usage tracking
- Research expansion mode (`/expand` command)
- Semantic search indexing (`/index` command)
- Interactive commands: `/model`, `/usage`, `/compact`, `/export`, `/version`
- Automatic update checking
- Context window management
