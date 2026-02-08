/**
 * loop.ts — ReAct Agent main loop (provider-agnostic)
 *
 * Drives the tool_use loop using the unified interface from providers.ts:
 *   1. Send messages + tool definitions to LLM
 *   2. If stopReason === "end_turn"  → return text
 *   3. If stopReason === "tool_use"  → execute tools → feed results back → continue loop
 *
 * Supports Anthropic Claude / OpenAI GPT / Google Gemini APIs.
 */

import {
  type LLMProvider,
  type LLMResponse,
  type ProviderHistory,
  type ProviderName,
  type TokenUsage,
  type ToolDefinition,
  getDefaultModel,
} from "./providers.js";
import { getToolDefinitions, executeTool } from "./tools.js";
import { buildSystemPrompt } from "./system-prompt.js";

// ─── Retry Configuration ─────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000; // 2s, 4s, 8s exponential backoff
const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];

// ─── Types ───────────────────────────────────────────────

export interface ToolCallEvent {
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultEvent {
  name: string;
  result: unknown;
  durationMs: number;
}

export interface AgentCallbacks {
  onThinking?: (text: string) => void;
  onToolCall?: (event: ToolCallEvent) => void;
  onToolResult?: (event: ToolResultEvent) => void;
  onText?: (text: string) => void;
  /** Streaming: called for each text token as it arrives from the LLM */
  onToken?: (token: string) => void;
}

export interface AgentResult {
  text: string;
  toolCalls: ToolCallEvent[];
  iterations: number;
  usage: TokenUsage;
}

// ─── Runtime Configuration ───────────────────────────────

export interface AgentConfig {
  providerName: ProviderName;
  model?: string;
  maxIterations?: number;
  maxTokens?: number;
}

const VALID_PROVIDERS: ProviderName[] = ["anthropic", "openai", "gemini"];

export function getAgentConfig(): AgentConfig {
  const rawProvider = process.env.LLM_PROVIDER || "anthropic";
  if (!VALID_PROVIDERS.includes(rawProvider as ProviderName)) {
    throw new Error(
      `Invalid LLM_PROVIDER "${rawProvider}". Must be one of: ${VALID_PROVIDERS.join(", ")}`,
    );
  }
  const providerName = rawProvider as ProviderName;
  const model = process.env.LLM_MODEL || getDefaultModel(providerName);
  const maxIterations = Number(process.env.MAX_ITERATIONS) || 25;
  const maxTokens = Number(process.env.MAX_TOKENS) || 4096;
  return { providerName, model, maxIterations, maxTokens };
}

// ─── Main Loop ───────────────────────────────────────────

/**
 * Run the Agent: feed user messages into a ReAct loop until the LLM returns final text.
 *
 * @param history  Provider-internal conversation history (managed by caller)
 * @param provider LLM Provider instance
 * @param config   Runtime configuration
 * @param callbacks Optional event callbacks (for real-time UI feedback)
 * @param systemPromptOverride Optional system prompt override (for /expand and other special modes)
 */
export async function agentLoop(
  history: ProviderHistory,
  provider: LLMProvider,
  config: AgentConfig,
  callbacks?: AgentCallbacks,
  systemPromptOverride?: string,
): Promise<AgentResult> {
  const maxIterations = config.maxIterations || 25;
  const maxTokens = config.maxTokens || 4096;
  const model = config.model || getDefaultModel(config.providerName);
  const tools: ToolDefinition[] = getToolDefinitions();
  const system = systemPromptOverride || buildSystemPrompt();

  const allToolCalls: ToolCallEvent[] = [];
  const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let iterations = 0;

  while (iterations < maxIterations) {
    iterations++;

    // 1. Call LLM (with auto-retry: exponential backoff for 429/5xx transient errors)
    const response = await chatWithRetry(
      provider,
      history,
      system,
      tools,
      model,
      maxTokens,
      callbacks?.onToken,
    );

    // Accumulate token usage
    if (response.usage) {
      totalUsage.inputTokens += response.usage.inputTokens;
      totalUsage.outputTokens += response.usage.outputTokens;
    }

    // 2. Intermediate text callback
    if (response.text) {
      callbacks?.onText?.(response.text);
    }

    // 3. If LLM decides to end the conversation
    if (response.stopReason === "end_turn") {
      return {
        text: response.text,
        toolCalls: allToolCalls,
        iterations,
        usage: totalUsage,
      };
    }

    // 4. If LLM requests tool use
    if (response.stopReason === "tool_use") {
      // Add assistant's tool_use response to history
      provider.pushAssistantToolUse(history, response);

      // Execute each tool sequentially
      const toolResultEntries: Array<{
        toolCallId: string;
        output: string;
      }> = [];

      for (const tc of response.toolCalls) {
        const event: ToolCallEvent = {
          name: tc.name,
          input: tc.input,
        };
        allToolCalls.push(event);
        callbacks?.onToolCall?.(event);

        const start = Date.now();
        let result: unknown;
        try {
          result = await executeTool(tc.name, tc.input);
        } catch (err: unknown) {
          const e = err as Error;
          result = { error: e.message };
        }
        const durationMs = Date.now() - start;

        callbacks?.onToolResult?.({ name: tc.name, result, durationMs });

        toolResultEntries.push({
          toolCallId: tc.id,
          output: JSON.stringify(result),
        });
      }

      // Feed tool results back to LLM
      provider.pushToolResults(history, toolResultEntries);

      // Continue loop
      continue;
    }

    // Unexpected stopReason — should not happen, but guard against infinite silent loop
    console.error(
      `  ⚠ Unexpected LLM stopReason: "${response.stopReason}". Treating as end_turn.`,
    );
    return {
      text: response.text || "[Agent received an unexpected response and stopped.]",
      toolCalls: allToolCalls,
      iterations,
      usage: totalUsage,
    };
  }

  // Reached maximum iteration limit
  return {
    text: "[Agent reached maximum iteration limit and stopped.]",
    toolCalls: allToolCalls,
    iterations,
    usage: totalUsage,
  };
}

// ─── LLM Call with Retry ─────────────────────────────────

/**
 * Determine if an error is a retryable transient error (429 rate limit, 5xx server errors, etc.).
 */
function isRetryableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return RETRYABLE_STATUS_CODES.some(
    (code) => msg.includes(`${code}`) || msg.includes("overloaded"),
  );
}

/**
 * LLM call with exponential backoff retry.
 * Automatically retries up to MAX_RETRIES times for 429/5xx transient errors.
 */
async function chatWithRetry(
  provider: LLMProvider,
  history: ProviderHistory,
  system: string,
  tools: ToolDefinition[],
  model: string,
  maxTokens: number,
  onToken?: (token: string) => void,
): Promise<LLMResponse> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await provider.chat(history, system, tools, model, maxTokens, onToken);
    } catch (err: unknown) {
      lastError = err;

      if (attempt < MAX_RETRIES && isRetryableError(err)) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        const errMsg = err instanceof Error ? err.message : String(err);
        const brief = errMsg.split("\n")[0].slice(0, 80);
        // If we were streaming, add a newline to separate partial output from retry message
        if (onToken) process.stdout.write("\n");
        console.error(
          `  ⟳ LLM temporarily unavailable (${brief}), retrying in ${delay / 1000}s (${attempt + 1}/${MAX_RETRIES})...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      // Non-retryable error, or max retries exceeded
      throw err;
    }
  }

  // TypeScript requires this line (actually unreachable)
  throw lastError;
}
