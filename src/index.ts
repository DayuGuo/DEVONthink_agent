#!/usr/bin/env node
/**
 * index.ts — CLI entry point
 *
 * Supports two modes:
 *   1. Interactive chat:  dt-agent
 *   2. Single query:      dt-agent "search all AI documents"
 *
 * Supports three LLM Providers: Anthropic Claude / OpenAI GPT / Google Gemini
 *
 * Strictly read-only access to DEVONthink databases, with web search capability.
 */

import { config as dotenvConfig } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Load .env from the script's directory, not cwd, so the global command works from any directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenvConfig({ path: resolve(__dirname, "..", ".env") });
import chalk from "chalk";

import {
  log,
  printBanner,
  printStatus,
  printHelp,
  createPrompt,
  askQuestion,
  startSpinner,
  stopSpinner,
} from "./ui/terminal.js";
import { formatToolInput, formatToolResult } from "./ui/formatter.js";
import { agentLoop, getAgentConfig, type AgentConfig } from "./agent/loop.js";
import { getToolNames } from "./agent/tools.js";
import { buildExpandPrompt } from "./agent/system-prompt.js";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  type ProviderName,
  type ProviderHistory,
  type TokenUsage,
  type LLMProvider,
  getProvider,
  getDefaultModel,
  getContextLimit,
  validateProviderKey,
  resetProviderCache,
} from "./agent/providers.js";
import { buildIndex, getIndexStatus } from "./rag/index-manager.js";
import { validateEmbeddingKey } from "./rag/embedder.js";
import { resetStoreCache } from "./rag/hybrid-search.js";
import { getCurrentVersion, checkForUpdates } from "./updater.js";

// ─── Cost Estimation ─────────────────────────────────────

/** Per-million-token rates (USD) for common models */
const MODEL_RATES: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-3-5-sonnet-latest": { input: 3, output: 15 },
  "claude-3-5-haiku-latest": { input: 0.8, output: 4 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gemini-2.5-flash": { input: 0.15, output: 0.6 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
};

function estimateCost(model: string, usage: TokenUsage): number {
  const rate = MODEL_RATES[model];
  if (!rate) return 0;
  return (usage.inputTokens * rate.input + usage.outputTokens * rate.output) / 1_000_000;
}

function formatCost(model: string, usage: TokenUsage): string {
  const cost = estimateCost(model, usage);
  if (cost <= 0) return "";
  return ` · ~$${cost.toFixed(4)}`;
}

// ─── Preflight Checks ────────────────────────────────────

function preflight(config: AgentConfig): void {
  const missing = validateProviderKey(config.providerName);
  if (missing) {
    log.error(
      `Provider "${config.providerName}" requires ${missing}. Please set it in .env.`,
    );
    process.exit(1);
  }
  if (process.platform !== "darwin") {
    log.warn(
      "This tool requires macOS osascript. Current platform may not be supported.",
    );
  }
}

// ─── Single Query Mode ──────────────────────────────────

async function singleQuery(query: string, config: AgentConfig): Promise<void> {
  const provider = getProvider(config.providerName);
  const history = provider.createHistory();
  provider.pushUserMessage(history, query);

  startSpinner("Thinking...");
  let streamed = false;

  const result = await agentLoop(history, provider, config, {
    onToken: (token) => {
      stopSpinner();
      streamed = true;
      process.stdout.write(token);
    },
    onToolCall: (e) => {
      stopSpinner();
      if (streamed) {
        console.log();
        streamed = false;
      }
      log.tool(e.name, formatToolInput(e.name, e.input));
      startSpinner(`Running ${e.name}...`);
    },
    onToolResult: (e) => {
      stopSpinner();
      log.toolDone(e.name, e.durationMs);
      startSpinner("Thinking...");
    },
  });
  stopSpinner();

  if (streamed) {
    console.log(); // Final newline after streamed text
  } else {
    console.log(result.text);
  }

  // Display token usage and cost for single query mode
  const model = config.model || getDefaultModel(config.providerName);
  const costStr = formatCost(model, result.usage);
  log.info(
    chalk.gray(
      `[${config.providerName}/${model} · ${result.iterations} iter · ${result.toolCalls.length} tools` +
        ` · ↑${result.usage.inputTokens.toLocaleString()} ↓${result.usage.outputTokens.toLocaleString()} tokens${costStr}]`,
    ),
  );
}

// ─── Interactive Chat Mode ──────────────────────────────

async function interactiveMode(config: AgentConfig): Promise<void> {
  printBanner(getCurrentVersion());
  printStatus({
    provider: config.providerName,
    model: config.model || getDefaultModel(config.providerName),
  });

  // Non-blocking startup update check (fire-and-forget)
  checkForUpdates()
    .then((info) => {
      if (info.updateAvailable && info.latestVersion) {
        log.warn(
          `Update available: v${getCurrentVersion()} → v${chalk.bold(info.latestVersion)}` +
            `  Run /version for details.`,
        );
      }
    })
    .catch(() => {});

  const rl = createPrompt();
  let provider: LLMProvider = getProvider(config.providerName);
  let history: ProviderHistory = provider.createHistory();
  const currentConfig = { ...config };
  let lastResponse = ""; // Used by /export
  const sessionUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  const prompt = chalk.green.bold("\nYou > ");

  while (true) {
    const input = (await askQuestion(rl, prompt)).trim();

    if (!input) continue;

    // ─── Slash Commands ───
    if (input.startsWith("/")) {
      // /expand preserves original case (topic may contain uppercase), other commands lowercase
      const spaceIdx = input.indexOf(" ");
      const cmd = (spaceIdx > 0 ? input.slice(0, spaceIdx) : input).toLowerCase();
      const cmdArg = spaceIdx > 0 ? input.slice(spaceIdx + 1).trim() : "";

      switch (cmd) {
        case "/help":
          printHelp();
          continue;

        case "/tools":
          log.info("Available tools:");
          getToolNames().forEach((t) => console.log("    " + chalk.magenta(t)));
          continue;

        case "/clear":
          history = provider.createHistory();
          lastResponse = "";
          log.success("Conversation history cleared");
          continue;

        case "/model": {
          const modelParts = cmdArg.toLowerCase().split(/\s+/);
          const arg = modelParts[0];
          if (!arg) {
            log.info(
              `Current: ${chalk.bold(currentConfig.providerName)} / ${chalk.bold(currentConfig.model || getDefaultModel(currentConfig.providerName))}`,
            );
            log.info("Usage: /model <provider> [model_name]");
            log.info("  provider: anthropic | openai | gemini");
            continue;
          }
          const validProviders: ProviderName[] = ["anthropic", "openai", "gemini"];
          if (!validProviders.includes(arg as ProviderName)) {
            log.warn(`Invalid provider: ${arg}. Options: ${validProviders.join(", ")}`);
            continue;
          }
          const newProvider = arg as ProviderName;
          const missing = validateProviderKey(newProvider);
          if (missing) {
            log.error(
              `Switch failed: ${missing} not found. Please configure it in .env.`,
            );
            continue;
          }
          const newModel = modelParts[1] || getDefaultModel(newProvider);
          currentConfig.providerName = newProvider;
          currentConfig.model = newModel;
          resetProviderCache();
          provider = getProvider(newProvider);
          history = provider.createHistory();
          lastResponse = "";
          log.success(
            `Switched to ${chalk.bold(newProvider)} / ${chalk.bold(newModel)} (conversation history cleared)`,
          );
          continue;
        }

        // ─── /expand: Research Expansion Mode ───
        case "/expand": {
          if (!cmdArg) {
            log.warn("Usage: /expand <research topic>");
            log.info("  Example: /expand schistosomiasis ultrasound diagnosis");
            continue;
          }

          log.blank();
          log.info(
            chalk.cyan.bold("Research Expansion Mode") +
              chalk.gray(` — Topic: "${cmdArg}"`),
          );
          log.info(
            chalk.gray(
              "Agent will deeply read database materials and search the web to generate an expansion report...",
            ),
          );
          log.divider();

          // Create independent history and config for expansion mode
          const expandHistory = provider.createHistory();
          const expandSystemPrompt = buildExpandPrompt(cmdArg);
          provider.pushUserMessage(
            expandHistory,
            `Please perform a deep research expansion analysis on "${cmdArg}".`,
          );

          const expandConfig: AgentConfig = {
            ...currentConfig,
            maxIterations: Math.max(currentConfig.maxIterations || 25, 40),
          };

          startSpinner("Researching...");
          let expandToolIndex = 0;
          let expandHeaderShown = false;

          try {
            const result = await agentLoop(
              expandHistory,
              provider,
              expandConfig,
              {
                onToken: (token) => {
                  stopSpinner();
                  if (!expandHeaderShown) {
                    log.blank();
                    log.divider();
                    process.stdout.write(chalk.bold("\nAgent > "));
                    expandHeaderShown = true;
                  }
                  process.stdout.write(token);
                },
                onToolCall: (e) => {
                  stopSpinner();
                  if (expandHeaderShown) {
                    console.log();
                    expandHeaderShown = false;
                  }
                  expandToolIndex++;
                  const detail = formatToolInput(e.name, e.input);
                  log.tool(`[${expandToolIndex}] ${e.name}`, detail);
                  startSpinner(`Running ${e.name}...`);
                },
                onToolResult: (e) => {
                  stopSpinner();
                  const summary = formatToolResult(e.name, e.result);
                  log.toolDone(e.name, e.durationMs);
                  console.log(chalk.gray("     " + summary));
                  startSpinner("Researching...");
                },
                onText: () => {},
              },
              expandSystemPrompt,
            );
            stopSpinner();

            if (expandHeaderShown) {
              console.log();
              log.divider();
            } else {
              log.blank();
              log.divider();
              console.log(chalk.bold("\nAgent > ") + result.text);
              log.divider();
            }

            lastResponse = result.text;

            // Inject a summary of the expansion result into main history
            // so subsequent conversation has context about the report
            provider.pushUserMessage(
              history,
              `[System: Research expansion on "${cmdArg}" was completed. The report is available via /export.]`,
            );
            provider.pushAssistantText(
              history,
              `I completed a research expansion analysis on "${cmdArg}". The full report has been generated. You can export it with /export or ask me follow-up questions about it.`,
            );

            // Accumulate session usage
            sessionUsage.inputTokens += result.usage.inputTokens;
            sessionUsage.outputTokens += result.usage.outputTokens;

            const model =
              currentConfig.model || getDefaultModel(currentConfig.providerName);
            const costStr = formatCost(model, result.usage);
            log.info(
              chalk.gray(
                `[Research Expansion · ${currentConfig.providerName}/${model} · ${result.iterations} iter · ${result.toolCalls.length} tools` +
                  ` · ↑${result.usage.inputTokens.toLocaleString()} ↓${result.usage.outputTokens.toLocaleString()}${costStr}]`,
              ),
            );
            log.info(
              chalk.cyan(`Tip: Type /export to save the report as a Markdown file`),
            );
          } catch (err: unknown) {
            stopSpinner();
            log.error(
              `Expansion error: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          continue;
        }

        // ─── /export: Export Last Response as Markdown ───
        case "/export": {
          if (!lastResponse) {
            log.warn("Nothing to export. Start a conversation or use /expand first.");
            continue;
          }

          const exportsDir = resolve(__dirname, "..", "exports");
          mkdirSync(exportsDir, { recursive: true });

          const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          const slugName = cmdArg
            ? cmdArg.replace(/[/\\?%*:|"<>]/g, "_").slice(0, 50)
            : "report";
          const fileName = `${slugName}_${timestamp}.md`;
          const filePath = resolve(exportsDir, fileName);

          writeFileSync(filePath, lastResponse, "utf-8");
          log.success(`Report exported: ${filePath}`);
          continue;
        }

        // ─── /index: Build Semantic Search Index ───
        case "/index": {
          const indexArgs = cmdArg.toLowerCase().split(/\s+/).filter(Boolean);
          const isForce = indexArgs.includes("--force");
          const isStatus = indexArgs.includes("--status");
          const dbArg = indexArgs.find((a) => !a.startsWith("--"));

          // Show status
          if (isStatus) {
            const status = getIndexStatus();
            if (!status) {
              log.warn("No semantic index found. Run /index to build one.");
            } else {
              log.info(`Index status:`);
              console.log(
                `    Provider:   ${chalk.bold(status.embeddingProvider)} / ${chalk.bold(status.embeddingModel)}`,
              );
              console.log(`    Dimensions: ${chalk.bold(String(status.dimensions))}`);
              console.log(`    Documents:  ${chalk.bold(String(status.totalDocuments))}`);
              console.log(`    Chunks:     ${chalk.bold(String(status.totalChunks))}`);
              console.log(`    Updated:    ${chalk.bold(status.lastUpdated)}`);
            }
            continue;
          }

          // Validate embedding API key
          const embMissing = validateEmbeddingKey();
          if (embMissing) {
            log.error(`Embedding requires ${embMissing}. Please set it in .env.`);
            log.info(
              `Configure EMBEDDING_PROVIDER (openai/gemini) and the corresponding API key.`,
            );
            continue;
          }

          log.blank();
          log.info(
            chalk.cyan.bold("Building Semantic Search Index") +
              (isForce ? chalk.yellow(" (force rebuild)") : "") +
              (dbArg ? chalk.gray(` — database: "${dbArg}"`) : ""),
          );
          log.divider();

          try {
            const stats = await buildIndex({
              database: dbArg,
              force: isForce,
              onProgress: (msg) => log.info(chalk.gray(msg)),
            });
            log.divider();
            log.success(
              `Indexed ${stats.indexedDocuments} docs → ${stats.totalChunks} chunks ` +
                `(${stats.skippedDocuments} skipped, ${stats.errors} errors, ` +
                `${(stats.durationMs / 1000).toFixed(1)}s)`,
            );
            // Reset cached store so next search uses updated index
            resetStoreCache();
          } catch (err: unknown) {
            log.error(
              `Index build failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          continue;
        }

        // ─── /compact: Trim conversation history to save context ───
        case "/compact": {
          const msgs = history._messages as Array<{ role?: string; content?: unknown }>;
          const oldLen = msgs.length;

          // Find safe cut points: indices where a real user message starts a new exchange.
          // A "safe" cut point ensures we never split a tool_use/tool_result pair.
          // For Anthropic: real user messages have string content (not array tool_results).
          // For OpenAI: real user messages have role "user" (tool results have role "tool").
          // For Gemini: real user messages have text parts (tool results have functionResponse parts).
          const safeCutPoints: number[] = [];
          for (let i = 0; i < msgs.length; i++) {
            const m = msgs[i];
            if (m.role !== "user") continue;
            // Anthropic: role "user" is shared with tool_results (content is array)
            if (provider.name === "anthropic" && typeof m.content !== "string") continue;
            // Gemini: role "user" is shared with functionResponse (parts contain functionResponse)
            if (provider.name === "gemini" && Array.isArray(m.content)) {
              const parts = m.content as Array<Record<string, unknown>>;
              if (parts.some((p) => "functionResponse" in p)) continue;
            }
            // OpenAI: tool results have role "tool", not "user", so no filtering needed
            safeCutPoints.push(i);
          }

          if (safeCutPoints.length <= 2) {
            log.info("History is already compact.");
            continue;
          }

          // Keep from the 2nd-to-last real user message onwards (≈ 2 exchanges)
          const keepFrom = safeCutPoints[safeCutPoints.length - 2];
          history._messages = msgs.slice(keepFrom) as unknown[];
          const newLen = (history._messages as unknown[]).length;
          log.success(
            `Compacted history: ${oldLen} → ${newLen} messages. Older context trimmed.`,
          );
          continue;
        }

        // ─── /usage: Show session token usage ───
        case "/usage": {
          const model =
            currentConfig.model || getDefaultModel(currentConfig.providerName);
          const ctxLimit = getContextLimit(model);
          log.info("Session token usage:");
          console.log(
            `    Input:   ${chalk.bold(sessionUsage.inputTokens.toLocaleString())} tokens`,
          );
          console.log(
            `    Output:  ${chalk.bold(sessionUsage.outputTokens.toLocaleString())} tokens`,
          );
          console.log(
            `    Total:   ${chalk.bold((sessionUsage.inputTokens + sessionUsage.outputTokens).toLocaleString())} tokens`,
          );
          console.log(
            `    Context: ${chalk.bold(ctxLimit.toLocaleString())} token limit (${model})`,
          );
          const cost = estimateCost(model, sessionUsage);
          if (cost > 0) {
            console.log(`    Est. cost: ${chalk.bold("$" + cost.toFixed(4))}`);
          }
          continue;
        }

        // ─── /version: Show version and check for updates ───
        case "/version": {
          const ver = getCurrentVersion();
          log.info(`DEVONthink Agent AI v${chalk.bold(ver)}`);
          startSpinner("Checking for updates...");
          try {
            const info = await checkForUpdates(true);
            stopSpinner();
            if (info.updateAvailable && info.latestVersion) {
              log.warn(`Update available: v${ver} → v${chalk.bold(info.latestVersion)}`);
              log.info(`Run: ${chalk.cyan("git pull && npm install && npm run build")}`);
              if (info.releaseUrl) {
                log.info(`Release: ${chalk.underline(info.releaseUrl)}`);
              }
            } else if (info.latestVersion) {
              log.success("You are on the latest version.");
            } else {
              log.info(
                "Could not check for updates (repository not configured or unreachable).",
              );
            }
          } catch {
            stopSpinner();
            log.info(`Version: v${ver} (update check failed)`);
          }
          continue;
        }

        case "/exit":
        case "/quit":
          log.info("Goodbye!");
          rl.close();
          process.exit(0);
          break; // unreachable, but satisfies no-fallthrough

        default:
          log.warn(`Unknown command: ${cmd}. Type /help for available commands.`);
          continue;
      }
    }

    // ─── Send to Agent ───
    provider.pushUserMessage(history, input);

    startSpinner("Thinking...");
    let toolIndex = 0;
    let headerShown = false;

    try {
      const result = await agentLoop(history, provider, currentConfig, {
        onToken: (token) => {
          stopSpinner();
          if (!headerShown) {
            log.blank();
            log.divider();
            process.stdout.write(chalk.bold("\nAgent > "));
            headerShown = true;
          }
          process.stdout.write(token);
        },
        onToolCall: (e) => {
          stopSpinner();
          if (headerShown) {
            console.log(); // newline after any streamed text
            headerShown = false;
          }
          toolIndex++;
          const detail = formatToolInput(e.name, e.input);
          log.tool(`[${toolIndex}] ${e.name}`, detail);
          startSpinner(`Running ${e.name}...`);
        },
        onToolResult: (e) => {
          stopSpinner();
          const summary = formatToolResult(e.name, e.result);
          log.toolDone(e.name, e.durationMs);
          console.log(chalk.gray("     " + summary));
          startSpinner("Thinking...");
        },
        onText: () => {},
      });
      stopSpinner();

      // Display final response
      if (headerShown) {
        console.log(); // Final newline after streamed text
        log.divider();
      } else {
        // Fallback: no streaming happened
        log.blank();
        log.divider();
        console.log(chalk.bold("\nAgent > ") + result.text);
        log.divider();
      }

      // Save last response (for /export)
      lastResponse = result.text;

      // Add assistant response to history
      provider.pushAssistantText(history, result.text);

      // Accumulate session usage
      sessionUsage.inputTokens += result.usage.inputTokens;
      sessionUsage.outputTokens += result.usage.outputTokens;

      // Display per-turn stats with usage
      const model = currentConfig.model || getDefaultModel(currentConfig.providerName);
      const costStr = formatCost(model, result.usage);
      log.info(
        chalk.gray(
          `[${currentConfig.providerName}/${model} · ${result.iterations} iter · ${result.toolCalls.length} tools` +
            ` · ↑${result.usage.inputTokens.toLocaleString()} ↓${result.usage.outputTokens.toLocaleString()} tokens${costStr}` +
            ` · session: ${(sessionUsage.inputTokens + sessionUsage.outputTokens).toLocaleString()}]`,
        ),
      );

      // Context window warning
      const ctxLimit = getContextLimit(model);
      if (result.usage.inputTokens > ctxLimit * 0.75) {
        const pct = Math.round((result.usage.inputTokens / ctxLimit) * 100);
        log.warn(
          `Context usage: ${pct}% of ${ctxLimit.toLocaleString()} limit. Use /compact or /clear to free space.`,
        );
      }
    } catch (err: unknown) {
      stopSpinner();
      if (headerShown) console.log(); // newline if we were streaming
      const e = err instanceof Error ? err.message : String(err);
      log.error(`Agent error: ${e}`);

      // Push a synthetic assistant message to maintain alternating user/assistant
      // pattern in history
      provider.pushAssistantText(
        history,
        "[Error occurred during processing. Please try again.]",
      );
    }
  }
}

// ─── Main ────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = getAgentConfig();

  const args = process.argv.slice(2);

  if (args.includes("--version") || args.includes("-v")) {
    console.log(`dt-agent v${getCurrentVersion()}`);
    process.exit(0);
  }

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage:
  dt-agent                   Interactive chat mode
  dt-agent "query"           Single query mode
  dt-agent --version         Show version
  dt-agent --help            Show help

Environment Variables:
  LLM_PROVIDER               anthropic | openai | gemini (default: anthropic)
  LLM_MODEL                  Specify model (leave empty for provider default)
  ANTHROPIC_API_KEY           Anthropic API Key
  OPENAI_API_KEY              OpenAI API Key
  GOOGLE_API_KEY              Google Gemini API Key
  BRAVE_API_KEY               Brave Search Key (free 2000 req/month, recommended)
  TAVILY_API_KEY              Tavily Search Key (optional, higher quality, paid)
  JINA_API_KEY                Jina API Key (optional, search + page scraping)

Interactive Commands:
  /model <provider> [model]  Switch LLM Provider and model
  /tools                     Show available tools
  /usage                     Show session token usage & estimated cost
  /compact                   Trim conversation history to save context
  /index [database]          Build/update semantic search index
  /index --force             Force full index rebuild
  /index --status            Show index status
  /expand <topic>            Deep research expansion analysis
  /export [filename]         Export last response as Markdown
  /clear                     Clear conversation history
  /version                   Show version & check for updates
  /help                      Show help
  /exit                      Exit

Safety:
  Strictly read-only access to DEVONthink databases. No data will be modified.
`);
    process.exit(0);
  }

  preflight(config);

  // Single query: join all non-flag arguments as query
  const query = args.filter((a) => !a.startsWith("-")).join(" ");
  if (query) {
    await singleQuery(query, config);
  } else {
    await interactiveMode(config);
  }
}

main().catch((err) => {
  log.error(err.message);
  process.exit(1);
});
