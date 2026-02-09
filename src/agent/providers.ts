/**
 * providers.ts — Multi-LLM Provider abstraction layer
 *
 * Unifies the tool-calling interaction formats of Anthropic / OpenAI / Gemini,
 * so loop.ts doesn't need to care about underlying API differences.
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  GoogleGenerativeAI,
  type Content as GeminiContent,
  type Part as GeminiPart,
  type FunctionDeclaration,
  type FunctionDeclarationSchema,
  SchemaType,
} from "@google/generative-ai";

// ━━━ Common Interfaces ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Tool definition (Anthropic format as internal standard) */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolCallInfo {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMResponse {
  stopReason: "end_turn" | "tool_use";
  text: string;
  toolCalls: ToolCallInfo[];
  usage?: TokenUsage;
}

/**
 * Provider interface.
 * Each Provider maintains its own message history format,
 * exposing only unified interaction methods externally.
 */
export interface LLMProvider {
  name: string;
  /** Create an empty conversation history */
  createHistory(): ProviderHistory;
  /** Append a user message to history */
  pushUserMessage(history: ProviderHistory, text: string): void;
  /** Send current history to LLM, return unified result. If onToken is provided, stream text. */
  chat(
    history: ProviderHistory,
    system: string,
    tools: ToolDefinition[],
    model: string,
    maxTokens: number,
    onToken?: (token: string) => void,
  ): Promise<LLMResponse>;
  /** Add assistant's tool_use response to history */
  pushAssistantToolUse(history: ProviderHistory, response: LLMResponse): void;
  /** Add tool execution results to history */
  pushToolResults(
    history: ProviderHistory,
    results: Array<{ toolCallId: string; output: string }>,
  ): void;
  /** Add assistant's final text response to history */
  pushAssistantText(history: ProviderHistory, text: string): void;
}

/** Opaque history container */
export interface ProviderHistory {
  /** Provider name (for mismatch detection) */
  _provider: string;
  /** Provider-internal data */
  _messages: unknown[];
}

// ━━━ Anthropic Provider ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

type AnthropicMessage = Anthropic.Messages.MessageParam;

class AnthropicProvider implements LLMProvider {
  name = "anthropic";
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic();
  }

  createHistory(): ProviderHistory {
    return { _provider: "anthropic", _messages: [] as AnthropicMessage[] };
  }

  pushUserMessage(history: ProviderHistory, text: string): void {
    (history._messages as AnthropicMessage[]).push({
      role: "user",
      content: text,
    });
  }

  async chat(
    history: ProviderHistory,
    system: string,
    tools: ToolDefinition[],
    model: string,
    maxTokens: number,
    onToken?: (token: string) => void,
  ): Promise<LLMResponse> {
    const anthropicTools: Anthropic.Messages.Tool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Messages.Tool["input_schema"],
    }));

    const params = {
      model,
      max_tokens: maxTokens,
      system,
      tools: anthropicTools,
      messages: history._messages as AnthropicMessage[],
    };

    let response: Anthropic.Messages.Message;
    if (onToken) {
      const stream = this.client.messages.stream(params);
      stream.on("text", (t) => onToken(t));
      response = await stream.finalMessage();
    } else {
      response = await this.client.messages.create(params);
    }

    const textBlocks = response.content.filter(
      (b): b is Anthropic.Messages.TextBlock => b.type === "text",
    );
    const text = textBlocks.map((b) => b.text).join("");
    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };

    if (response.stop_reason === "tool_use") {
      const toolCalls = response.content
        .filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          name: b.name,
          input: b.input as Record<string, unknown>,
        }));
      (history as { _rawContent?: unknown })._rawContent = response.content;
      return { stopReason: "tool_use", text, toolCalls, usage };
    }

    return { stopReason: "end_turn", text, toolCalls: [], usage };
  }

  pushAssistantToolUse(history: ProviderHistory, _response: LLMResponse): void {
    const raw = (history as { _rawContent?: unknown })._rawContent;
    (history._messages as AnthropicMessage[]).push({
      role: "assistant",
      content: raw as Anthropic.Messages.ContentBlock[],
    });
    delete (history as { _rawContent?: unknown })._rawContent;
  }

  pushToolResults(
    history: ProviderHistory,
    results: Array<{ toolCallId: string; output: string }>,
  ): void {
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = results.map((r) => ({
      type: "tool_result" as const,
      tool_use_id: r.toolCallId,
      content: r.output,
    }));
    (history._messages as AnthropicMessage[]).push({
      role: "user",
      content: toolResults,
    });
  }

  pushAssistantText(history: ProviderHistory, text: string): void {
    (history._messages as AnthropicMessage[]).push({
      role: "assistant",
      content: text,
    });
  }
}

// ━━━ OpenAI Provider ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

type OpenAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

class OpenAIProvider implements LLMProvider {
  name = "openai";
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI();
  }

  createHistory(): ProviderHistory {
    return { _provider: "openai", _messages: [] as OpenAIMessage[] };
  }

  pushUserMessage(history: ProviderHistory, text: string): void {
    (history._messages as OpenAIMessage[]).push({
      role: "user",
      content: text,
    });
  }

  async chat(
    history: ProviderHistory,
    system: string,
    tools: ToolDefinition[],
    model: string,
    maxTokens: number,
    onToken?: (token: string) => void,
  ): Promise<LLMResponse> {
    const openaiTools: OpenAI.Chat.Completions.ChatCompletionTool[] = tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    const messages: OpenAIMessage[] = [
      { role: "system", content: system },
      ...(history._messages as OpenAIMessage[]),
    ];

    if (onToken) {
      // Streaming mode
      const stream = await this.client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        messages,
        tools: openaiTools.length > 0 ? openaiTools : undefined,
        stream: true,
        stream_options: { include_usage: true },
      });

      let text = "";
      const tcDeltas = new Map<number, { id: string; name: string; args: string }>();
      let finishReason = "";
      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

      for await (const chunk of stream) {
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens || 0,
            outputTokens: chunk.usage.completion_tokens || 0,
          };
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.delta?.content) {
          text += choice.delta.content;
          onToken(choice.delta.content);
        }
        if (choice.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const existing = tcDeltas.get(tc.index);
            if (!existing) {
              tcDeltas.set(tc.index, {
                id: tc.id || "",
                name: tc.function?.name || "",
                args: tc.function?.arguments || "",
              });
            } else {
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name += tc.function.name;
              existing.args += tc.function?.arguments || "";
            }
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }

      if (finishReason === "tool_calls" && tcDeltas.size > 0) {
        const toolCalls: ToolCallInfo[] = [...tcDeltas.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, tc]) => ({
            id: tc.id,
            name: tc.name,
            input: JSON.parse(tc.args || "{}"),
          }));
        const rawMsg = {
          role: "assistant" as const,
          content: text || null,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          })),
        };
        (history as { _rawMsg?: unknown })._rawMsg = rawMsg;
        return { stopReason: "tool_use", text, toolCalls, usage };
      }

      return { stopReason: "end_turn", text, toolCalls: [], usage };
    }

    // Non-streaming mode
    const response = await this.client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      messages,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
    });

    const choice = response.choices[0];
    if (!choice) throw new Error("OpenAI returned no choices");

    const text = choice.message.content || "";
    const usage: TokenUsage = {
      inputTokens: response.usage?.prompt_tokens || 0,
      outputTokens: response.usage?.completion_tokens || 0,
    };

    if (choice.finish_reason === "tool_calls" && choice.message.tool_calls?.length) {
      const toolCalls: ToolCallInfo[] = choice.message.tool_calls
        .filter(
          (tc): tc is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
            tc.type === "function",
        )
        .map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || "{}"),
        }));
      (history as { _rawMsg?: unknown })._rawMsg = choice.message;
      return { stopReason: "tool_use", text, toolCalls, usage };
    }

    return { stopReason: "end_turn", text, toolCalls: [], usage };
  }

  pushAssistantToolUse(history: ProviderHistory, _response: LLMResponse): void {
    const raw = (history as { _rawMsg?: unknown })._rawMsg;
    (history._messages as OpenAIMessage[]).push(
      raw as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam,
    );
    delete (history as { _rawMsg?: unknown })._rawMsg;
  }

  pushToolResults(
    history: ProviderHistory,
    results: Array<{ toolCallId: string; output: string }>,
  ): void {
    for (const r of results) {
      (history._messages as OpenAIMessage[]).push({
        role: "tool",
        tool_call_id: r.toolCallId,
        content: r.output,
      });
    }
  }

  pushAssistantText(history: ProviderHistory, text: string): void {
    (history._messages as OpenAIMessage[]).push({
      role: "assistant",
      content: text,
    });
  }
}

// ━━━ Gemini Provider ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class GeminiProvider implements LLMProvider {
  name = "gemini";
  private client: GoogleGenerativeAI;

  constructor() {
    const key = process.env.GOOGLE_API_KEY;
    if (!key) throw new Error("GOOGLE_API_KEY is not set");
    this.client = new GoogleGenerativeAI(key);
  }

  createHistory(): ProviderHistory {
    return { _provider: "gemini", _messages: [] as GeminiContent[] };
  }

  pushUserMessage(history: ProviderHistory, text: string): void {
    (history._messages as GeminiContent[]).push({
      role: "user",
      parts: [{ text }],
    });
  }

  async chat(
    history: ProviderHistory,
    system: string,
    tools: ToolDefinition[],
    model: string,
    maxTokens: number,
    onToken?: (token: string) => void,
  ): Promise<LLMResponse> {
    const genModel = this.client.getGenerativeModel({
      model,
      systemInstruction: system,
      tools: [
        {
          functionDeclarations: tools.map((t) => toGeminiFunctionDeclaration(t)),
        },
      ],
      generationConfig: {
        maxOutputTokens: maxTokens,
      },
    });

    // Separate the last message from history and send it via sendMessage.
    const msgs = history._messages as GeminiContent[];
    if (msgs.length === 0) throw new Error("Message history is empty");

    const historyForChat = msgs.slice(0, -1);
    const lastMsg = msgs[msgs.length - 1];

    const chat = genModel.startChat({ history: historyForChat });

    let response;
    if (onToken) {
      // Streaming mode
      const streamResult = await chat.sendMessageStream(
        lastMsg.parts as Array<string | GeminiPart>,
      );
      for await (const chunk of streamResult.stream) {
        try {
          const chunkText = chunk.text();
          if (chunkText) onToken(chunkText);
        } catch {
          // chunk.text() may throw if no text content
        }
      }
      response = await streamResult.response;
    } else {
      // Non-streaming mode
      const result = await chat.sendMessage(lastMsg.parts as Array<string | GeminiPart>);
      response = result.response;
    }

    const candidate = response.candidates?.[0];
    if (!candidate) throw new Error("Gemini returned no candidates");

    const parts = candidate.content.parts;
    const textParts = parts
      .filter((p): p is { text: string } => "text" in p)
      .map((p) => p.text);
    const text = textParts.join("");

    const usage: TokenUsage = {
      inputTokens: response.usageMetadata?.promptTokenCount || 0,
      outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
    };

    const functionCalls = parts.filter(
      (
        p,
      ): p is GeminiPart & {
        functionCall: { name: string; args: Record<string, unknown> };
      } => "functionCall" in p,
    );

    if (functionCalls.length > 0) {
      const toolCalls: ToolCallInfo[] = functionCalls.map((fc, i) => ({
        id: `gemini-tc-${Date.now()}-${i}`,
        name: fc.functionCall.name,
        input: (fc.functionCall.args || {}) as Record<string, unknown>,
      }));
      return { stopReason: "tool_use", text, toolCalls, usage };
    }

    return { stopReason: "end_turn", text, toolCalls: [], usage };
  }

  pushAssistantToolUse(history: ProviderHistory, response: LLMResponse): void {
    const parts: GeminiPart[] = [];
    if (response.text) {
      parts.push({ text: response.text });
    }
    for (const tc of response.toolCalls) {
      parts.push({
        functionCall: { name: tc.name, args: tc.input },
      });
    }
    (history._messages as GeminiContent[]).push({
      role: "model",
      parts,
    });
  }

  pushToolResults(
    history: ProviderHistory,
    results: Array<{ toolCallId: string; output: string }>,
  ): void {
    // Gemini tool results go in a single function-role message.
    // Extract functionCall names from the last model message for name matching.
    const msgs = history._messages as GeminiContent[];
    const lastModel = [...msgs].reverse().find((m) => m.role === "model");

    // Build a lookup map from toolCallId → functionCall name for robust matching
    // (avoids fragile positional index matching if order ever diverges)
    const idToName = new Map<string, string>();
    const lastModelParts = lastModel?.parts || [];
    let fcIdx = 0;
    for (const p of lastModelParts) {
      if ("functionCall" in p) {
        // Gemini tool call IDs are generated as "gemini-tc-{timestamp}-{index}"
        // Match by position within functionCallParts since Gemini doesn't have native IDs
        const matchingResult = results[fcIdx];
        if (matchingResult) {
          idToName.set(
            matchingResult.toolCallId,
            (p as GeminiPart & { functionCall: { name: string } }).functionCall.name,
          );
        }
        fcIdx++;
      }
    }

    const parts: GeminiPart[] = results.map((r) => {
      const name = idToName.get(r.toolCallId) || "unknown";
      // Gemini API requires functionResponse.response to be an Object,
      // not an Array or primitive value. If the tool returns an array
      // or non-object type, wrap it as { result: ... }
      const parsed: unknown = JSON.parse(r.output);
      const responseObj =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { result: parsed };
      return {
        functionResponse: {
          name,
          response: responseObj,
        },
      };
    });

    // Gemini requires function responses in a "function" role message
    // Note: TypeScript types may not expose "function" role, so we use type assertion
    (history._messages as GeminiContent[]).push({
      role: "function" as GeminiContent["role"],
      parts,
    });
  }

  pushAssistantText(history: ProviderHistory, text: string): void {
    (history._messages as GeminiContent[]).push({
      role: "model",
      parts: [{ text }],
    });
  }
}

// Gemini tool definition conversion
function toGeminiFunctionDeclaration(tool: ToolDefinition): FunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parameters: convertSchemaToGemini(tool.input_schema),
  };
}

/**
 * Convert JSON Schema to Gemini's FunctionDeclarationSchema.
 *
 * The Gemini SDK's Schema type is a strict discriminated union,
 * but FunctionDeclarationSchema itself is a more relaxed interface.
 * We directly build objects that satisfy runtime requirements
 * and use type assertions to bypass compile-time checks.
 */
function convertSchemaToGemini(
  schema: ToolDefinition["input_schema"],
): FunctionDeclarationSchema {
  const properties: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(schema.properties)) {
    const v = val as Record<string, unknown>;
    const prop: Record<string, unknown> = {
      type: v.type as string,
      description: (v.description as string) || "",
    };
    if (v.type === "array" && v.items) {
      prop.items = {
        type: (v.items as Record<string, unknown>).type as string,
      };
    }
    properties[key] = prop;
  }
  // FunctionDeclarationSchema expects { type, properties, required?, description? }
  return {
    type: SchemaType.OBJECT,
    properties,
    required: schema.required || [],
  } as FunctionDeclarationSchema;
}

// ━━━ Provider Factory ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type ProviderName = "anthropic" | "openai" | "gemini";

const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o",
  gemini: "gemini-2.5-flash",
};

let cachedProviders: Partial<Record<ProviderName, LLMProvider>> = {};

export function getProvider(name: ProviderName): LLMProvider {
  if (cachedProviders[name]) return cachedProviders[name]!;

  let provider: LLMProvider;
  switch (name) {
    case "anthropic":
      provider = new AnthropicProvider();
      break;
    case "openai":
      provider = new OpenAIProvider();
      break;
    case "gemini":
      provider = new GeminiProvider();
      break;
    default:
      throw new Error(`Unsupported provider: ${name}`);
  }

  cachedProviders[name] = provider;
  return provider;
}

export function getDefaultModel(name: ProviderName): string {
  return DEFAULT_MODELS[name];
}

export function resetProviderCache(): void {
  cachedProviders = {};
}

/** Get the context window size for a model (in tokens) */
export function getContextLimit(model: string): number {
  if (model.includes("claude")) return 200_000;
  if (model.includes("gpt-4o")) return 128_000;
  if (model.includes("gpt-4-turbo")) return 128_000;
  if (model.includes("gpt-3.5")) return 16_385;
  if (model.includes("gemini")) return 1_048_576;
  return 128_000;
}

/** Validate whether the Provider's API Key is configured */
export function validateProviderKey(name: ProviderName): string | null {
  switch (name) {
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY ? null : "ANTHROPIC_API_KEY";
    case "openai":
      return process.env.OPENAI_API_KEY ? null : "OPENAI_API_KEY";
    case "gemini":
      return process.env.GOOGLE_API_KEY ? null : "GOOGLE_API_KEY";
    default:
      return `UNKNOWN_PROVIDER(${name})`;
  }
}
