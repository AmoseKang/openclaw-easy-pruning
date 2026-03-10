import type {
  EasyPruningConfig,
  Logger,
  MessageLike,
  MessageZone,
  SummaryProvider,
} from "./pruner.js";

export type StrategyContext = {
  config: EasyPruningConfig;
  zone: MessageZone;
};

export type StrategyDeps = {
  logger?: Logger;
  summaryProvider?: SummaryProvider;
};

export interface PruningStrategy {
  name: "soft" | "hard" | "detail";
  apply(message: MessageLike, ctx: StrategyContext): Promise<MessageLike>;
}

export function createStrategies(
  config: EasyPruningConfig,
  deps: StrategyDeps = {},
): Record<"soft" | "hard" | "detail", PruningStrategy> {
  return {
    soft: {
      name: "soft",
      apply: async (message) => applySoftPruning(message, config),
    },
    hard: {
      name: "hard",
      apply: async (message) => applyHardPruning(message, config),
    },
    detail: {
      name: "detail",
      apply: async (message) => applyDetailPruning(message, config, deps),
    },
  };
}

function textBlock(text: string) {
  return { type: "text", text };
}

function roleOf(message: MessageLike): string {
  return String(message.role ?? "");
}

function isToolResultRole(role: string): boolean {
  return role === "tool_result" || role === "toolResult";
}

function isAssistantRole(role: string): boolean {
  return role === "assistant";
}

function normalizeBlockType(value: unknown): string {
  return String(value ?? "").replace(/[-_\s]/g, "").toLowerCase();
}

function isToolCallType(type: unknown): boolean {
  const normalized = normalizeBlockType(type);
  return normalized === "toolcall" || normalized === "functioncall";
}

function extractToolCallId(block: Record<string, unknown>): string | null {
  const keys = ["id", "call_id", "callId", "toolCallId", "function_call_id"];
  for (const key of keys) {
    const value = block[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function isToolCallBlock(block: unknown): block is Record<string, unknown> {
  if (!block || typeof block !== "object") {
    return false;
  }

  const obj = block as Record<string, unknown>;
  if (!isToolCallType(obj.type)) {
    return false;
  }

  return extractToolCallId(obj) !== null;
}

function hasToolCallBlocks(content: unknown): boolean {
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((b) => isToolCallBlock(b));
}

function clipUnknownString(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 3) {
    return value.slice(0, Math.max(0, maxChars));
  }
  return `${value.slice(0, maxChars - 3)}...`;
}

function compactUnknown(
  input: unknown,
  opts: { depth: number; maxArray: number; maxObjectKeys: number; maxStringChars: number },
): unknown {
  const { depth, maxArray, maxObjectKeys, maxStringChars } = opts;

  if (input == null) {
    return input;
  }

  if (typeof input === "string") {
    return clipUnknownString(input, maxStringChars);
  }

  if (typeof input === "number" || typeof input === "boolean") {
    return input;
  }

  if (depth <= 0) {
    return "[pruned]";
  }

  if (Array.isArray(input)) {
    const sliced = input.slice(0, maxArray).map((v) =>
      compactUnknown(v, { depth: depth - 1, maxArray, maxObjectKeys, maxStringChars }),
    );
    if (input.length > maxArray) {
      sliced.push(`[+${input.length - maxArray} items]`);
    }
    return sliced;
  }

  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(input as Record<string, unknown>).slice(0, maxObjectKeys);
    for (const [k, v] of entries) {
      out[k] = compactUnknown(v, {
        depth: depth - 1,
        maxArray,
        maxObjectKeys,
        maxStringChars,
      });
    }
    const total = Object.keys(input as Record<string, unknown>).length;
    if (total > maxObjectKeys) {
      out.__trimmedKeys = total - maxObjectKeys;
    }
    return out;
  }

  return String(input);
}

function compactToolCallBlock(
  block: Record<string, unknown>,
  config: EasyPruningConfig,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  // Preserve original type spelling for runtime compatibility.
  const typeValue = typeof block.type === "string" ? block.type : "toolCall";
  out.type = typeValue;

  // Keep id/name fields in both common spellings.
  const id = extractToolCallId(block);
  if (id) {
    if (typeof block.id === "string") out.id = id;
    if (typeof block.call_id === "string") out.call_id = id;
    if (typeof block.callId === "string") out.callId = id;
    if (typeof block.toolCallId === "string") out.toolCallId = id;
    if (typeof block.function_call_id === "string") out.function_call_id = id;

    // Ensure at least one canonical key exists.
    if (!("id" in out) && !("call_id" in out) && !("callId" in out)) {
      out.id = id;
    }
  }

  if (typeof block.name === "string") out.name = block.name;
  if (typeof block.functionName === "string") out.functionName = block.functionName;

  if (block.arguments !== undefined) {
    out.arguments = compactUnknown(block.arguments, {
      depth: 3,
      maxArray: 16,
      maxObjectKeys: 24,
      maxStringChars: Math.max(120, Math.floor(config.debug_preview_chars * 2)),
    });
  }

  if (block.input !== undefined) {
    out.input = compactUnknown(block.input, {
      depth: 3,
      maxArray: 16,
      maxObjectKeys: 24,
      maxStringChars: Math.max(120, Math.floor(config.debug_preview_chars * 2)),
    });
  }

  if (typeof block.partialJson === "string") {
    out.partialJson = clipUnknownString(block.partialJson, Math.max(120, config.debug_preview_chars));
  }

  return out;
}

function extractAssistantBlocks(content: unknown): {
  toolCalls: Array<Record<string, unknown>>;
  textLike: string;
  lastText: string | null;
} {
  if (!Array.isArray(content)) {
    return { toolCalls: [], textLike: "", lastText: null };
  }

  const toolCalls: Array<Record<string, unknown>> = [];
  const textParts: string[] = [];
  let lastText: string | null = null;

  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }

    const obj = block as Record<string, unknown>;
    const type = String(obj.type ?? "");

    if (isToolCallType(type) && extractToolCallId(obj)) {
      toolCalls.push(obj);
      continue;
    }

    if (type === "text" && typeof obj.text === "string") {
      textParts.push(obj.text);
      lastText = obj.text;
      continue;
    }

    if (type === "thinking" && typeof obj.thinking === "string") {
      textParts.push(obj.thinking);
      continue;
    }
  }

  return {
    toolCalls,
    textLike: textParts.join("\n"),
    lastText,
  };
}

function buildAssistantContentWithToolCalls(
  content: unknown,
  config: EasyPruningConfig,
  mode: "default" | "keep_last_reply" | "model_summary",
  modelSummary?: string,
): unknown {
  const { toolCalls, textLike, lastText } = extractAssistantBlocks(content);
  if (toolCalls.length === 0) {
    return content;
  }

  const keptToolCalls = toolCalls.map((b) => compactToolCallBlock(b, config));

  let text = "";
  if (mode === "keep_last_reply") {
    const core = lastText?.trim() || "";
    text = core
      ? `[Last assistant reply kept]\n\n${clipText(core, config.detail_summary_max_chars)}`
      : config.detail_placeholder;
  } else if (mode === "model_summary") {
    const core = (modelSummary || "").trim();
    text = core
      ? `[Model summary (assistant)]\n\n${clipText(core, config.detail_summary_max_chars)}`
      : config.detail_placeholder;
  } else {
    const core = (lastText || textLike || "").trim();
    text = core ? clipText(core, config.soft_trim.max_chars) : config.detail_placeholder;
  }

  return [...keptToolCalls, textBlock(text)];
}

function hasImageContent(content: unknown): boolean {
  if (typeof content === "string") {
    const lower = content.toLowerCase();
    return lower.includes("data:image") || lower.includes(".png") || lower.includes(".jpg");
  }

  if (Array.isArray(content)) {
    return content.some((item) => hasImageContent(item));
  }

  if (content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    const t = String(c.type ?? "").toLowerCase();
    if (t.includes("image")) {
      return true;
    }
    if (c.image || c.images) {
      return true;
    }
    if (typeof c.url === "string" && c.url.toLowerCase().includes("image")) {
      return true;
    }
  }

  return false;
}

function isAlreadyPrunedText(text: string): boolean {
  const v = text.trim();
  if (!v) return false;
  return (
    v.includes("[Model summary (") ||
    v.includes("[Process details pruned]") ||
    v.includes("[Old tool result content cleared]") ||
    v.includes("[Detailed execution context pruned to save tokens]")
  );
}

function isAlreadyPrunedContent(content: unknown): boolean {
  const unified = toUnifiedText(content);
  return isAlreadyPrunedText(unified);
}

function toUnifiedText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
        continue;
      }
      if (!block || typeof block !== "object") {
        continue;
      }
      const obj = block as Record<string, unknown>;
      if (obj.type === "text" && typeof obj.text === "string") {
        parts.push(obj.text);
      }
    }
    return parts.join("\n");
  }

  try {
    return JSON.stringify(content);
  } catch {
    return String(content ?? "");
  }
}

function preserveContentShape(original: unknown, text: string): unknown {
  if (typeof original === "string") {
    return text;
  }
  if (Array.isArray(original)) {
    return [textBlock(text)];
  }
  return text;
}

function extractFinalSummary(text: string): string | null {
  const markers = [
    "Final Answer:",
    "Final:",
    "Summary:",
    "Conclusion:",
    "Answer:",
    "Result:",
    "Output:",
    "最终结论",
    "总结",
    "结论",
  ];

  for (const marker of markers) {
    const idx = text.lastIndexOf(marker);
    if (idx !== -1) {
      const sliced = text.slice(idx).trim();
      if (sliced.length > 0) {
        return sliced;
      }
    }
  }

  // Fallback: keep final paragraph if no marker found
  const paras = text
    .split(/\n\s*\n/g)
    .map((p) => p.trim())
    .filter(Boolean);

  if (paras.length === 0) {
    return null;
  }

  const last = paras[paras.length - 1];
  return last.length > 0 ? last : null;
}

function extractLastAssistantReply(content: unknown): string | null {
  if (typeof content === "string") {
    return extractFinalSummary(content) ?? (content.trim() || null);
  }

  if (Array.isArray(content)) {
    const textBlocks = content
      .filter(
        (block) =>
          block &&
          typeof block === "object" &&
          (block as Record<string, unknown>).type === "text" &&
          typeof (block as Record<string, unknown>).text === "string",
      )
      .map((block) => String((block as Record<string, unknown>).text ?? "").trim())
      .filter(Boolean);

    if (textBlocks.length > 0) {
      return textBlocks[textBlocks.length - 1];
    }

    return null;
  }

  return null;
}

function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 3) {
    return text.slice(0, Math.max(0, maxChars));
  }
  return `${text.slice(0, maxChars - 3)}...`;
}

function heuristicSummary(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) {
    return "";
  }

  const key = extractFinalSummary(text) || clean;
  if (key.length <= maxChars) {
    return key;
  }

  const head = key.slice(0, Math.floor(maxChars * 0.6));
  const tail = key.slice(-Math.max(0, Math.floor(maxChars * 0.25)));
  return clipText(`${head} ... ${tail}`, maxChars);
}

export function applySoftPruning(message: MessageLike, config: EasyPruningConfig): MessageLike {
  const role = roleOf(message);
  if (!isToolResultRole(role)) {
    return message;
  }

  if (config.skip_tools_with_images && hasImageContent(message.content)) {
    return message;
  }

  const raw = toUnifiedText(message.content);
  if (raw.length <= config.soft_trim.max_chars) {
    return message;
  }

  const head = raw.slice(0, Math.max(0, config.soft_trim.head_chars));
  const tail = raw.slice(Math.max(0, raw.length - Math.max(0, config.soft_trim.tail_chars)));

  const soft = `${head}\n\n... (truncated)\n\n[Original size: ${raw.length} characters]\n${tail}`;

  return {
    ...message,
    content: preserveContentShape(message.content, soft),
  };
}

export function applyHardPruning(message: MessageLike, config: EasyPruningConfig): MessageLike {
  const role = roleOf(message);
  if (!isToolResultRole(role)) {
    return message;
  }

  if (config.skip_tools_with_images && hasImageContent(message.content)) {
    return message;
  }

  return {
    ...message,
    content: preserveContentShape(message.content, config.hard_clear_placeholder),
  };
}

export async function applyDetailPruning(
  message: MessageLike,
  config: EasyPruningConfig,
  deps: StrategyDeps = {},
): Promise<MessageLike> {
  const mode = config.detail_pruning_mode;

  if (mode === "keep_last_reply") {
    return applyDetailKeepLastReply(message, config);
  }

  if (mode === "model_summary") {
    return applyDetailModelSummary(message, config, deps);
  }

  return applyDetailDefault(message, config);
}

function applyDetailDefault(message: MessageLike, config: EasyPruningConfig): MessageLike {
  const role = roleOf(message);

  // Keep user/system out of detail pruning entirely (extra safety)
  if (role === "user" || role === "system") {
    return message;
  }

  if (isAlreadyPrunedContent(message.content)) {
    return message;
  }

  if (isAssistantRole(role)) {
    const content = message.content;

    // Critical safety: keep toolCall blocks (id/name) to preserve toolResult call_id linkage.
    if (hasToolCallBlocks(content)) {
      return {
        ...message,
        content: buildAssistantContentWithToolCalls(content, config, "default"),
      };
    }

    if (typeof content === "string") {
      return message;
    }

    if (Array.isArray(content)) {
      const textBlocks = content.filter(
        (block) =>
          block &&
          typeof block === "object" &&
          (block as Record<string, unknown>).type === "text" &&
          typeof (block as Record<string, unknown>).text === "string",
      );

      if (textBlocks.length > 0) {
        return {
          ...message,
          content: textBlocks,
        };
      }

      return {
        ...message,
        content: [textBlock(config.detail_placeholder)],
      };
    }

    return {
      ...message,
      content: config.detail_placeholder,
    };
  }

  if (isToolResultRole(role)) {
    if (config.skip_tools_with_images && hasImageContent(message.content)) {
      return message;
    }

    const unified = toUnifiedText(message.content);
    const summary = extractFinalSummary(unified);

    if (summary) {
      const value = `[Process details pruned]\n\n${summary}`;
      return {
        ...message,
        content: preserveContentShape(message.content, value),
      };
    }

    return {
      ...message,
      content: preserveContentShape(message.content, config.detail_placeholder),
    };
  }

  return message;
}

function applyDetailKeepLastReply(message: MessageLike, config: EasyPruningConfig): MessageLike {
  const role = roleOf(message);

  if (role === "user" || role === "system") {
    return message;
  }

  if (isAlreadyPrunedContent(message.content)) {
    return message;
  }

  if (isAssistantRole(role)) {
    if (hasToolCallBlocks(message.content)) {
      return {
        ...message,
        content: buildAssistantContentWithToolCalls(message.content, config, "keep_last_reply"),
      };
    }

    const lastReply = extractLastAssistantReply(message.content);
    if (!lastReply) {
      return {
        ...message,
        content: preserveContentShape(message.content, config.detail_placeholder),
      };
    }

    const value = `[Last assistant reply kept]\n\n${lastReply}`;
    return {
      ...message,
      content: preserveContentShape(message.content, value),
    };
  }

  if (isToolResultRole(role)) {
    if (config.skip_tools_with_images && hasImageContent(message.content)) {
      return message;
    }

    return {
      ...message,
      content: preserveContentShape(message.content, config.detail_placeholder),
    };
  }

  return message;
}

async function applyDetailModelSummary(
  message: MessageLike,
  config: EasyPruningConfig,
  deps: StrategyDeps,
): Promise<MessageLike> {
  const role = roleOf(message);

  if (role === "user" || role === "system") {
    return message;
  }

  if (isAlreadyPrunedContent(message.content)) {
    return message;
  }

  if (isToolResultRole(role) && config.skip_tools_with_images && hasImageContent(message.content)) {
    return message;
  }

  // Critical safety: assistant toolCall blocks must remain linkable by call_id,
  // even when there is no text payload to summarize.
  const assistantHasToolCalls = isAssistantRole(role) && hasToolCallBlocks(message.content);

  const raw = toUnifiedText(message.content);
  if (!raw.trim()) {
    if (assistantHasToolCalls) {
      return {
        ...message,
        content: buildAssistantContentWithToolCalls(message.content, config, "model_summary", ""),
      };
    }
    return {
      ...message,
      content: preserveContentShape(message.content, config.detail_placeholder),
    };
  }

  const provider = deps.summaryProvider;
  let summary: string | null = null;

  if (provider) {
    try {
      summary = await provider(raw, { role, maxChars: config.detail_summary_max_chars });
    } catch (error) {
      deps.logger?.warn?.(`[EasyPruning] model summary failed, fallback to heuristic: ${String(error)}`);
    }
  }

  if (!summary || !summary.trim()) {
    summary = heuristicSummary(raw, config.detail_summary_max_chars);
  }

  if (assistantHasToolCalls) {
    return {
      ...message,
      content: buildAssistantContentWithToolCalls(message.content, config, "model_summary", summary),
    };
  }

  const value = `[Model summary (${role})]\n\n${clipText(summary.trim(), config.detail_summary_max_chars)}`;
  return {
    ...message,
    content: preserveContentShape(message.content, value),
  };
}
