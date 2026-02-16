import type { EasyPruningConfig, MessageLike, MessageZone } from "./pruner.js";

export type StrategyContext = {
  config: EasyPruningConfig;
  zone: MessageZone;
};

export interface PruningStrategy {
  name: "soft" | "hard" | "detail";
  apply(message: MessageLike, ctx: StrategyContext): MessageLike;
}

export function createStrategies(config: EasyPruningConfig): Record<"soft" | "hard" | "detail", PruningStrategy> {
  return {
    soft: {
      name: "soft",
      apply: (message) => applySoftPruning(message, config),
    },
    hard: {
      name: "hard",
      apply: (message) => applyHardPruning(message, config),
    },
    detail: {
      name: "detail",
      apply: (message) => applyDetailPruning(message, config),
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

export function applyDetailPruning(message: MessageLike, config: EasyPruningConfig): MessageLike {
  const role = roleOf(message);

  // Keep user/system out of detail pruning entirely (extra safety)
  if (role === "user" || role === "system") {
    return message;
  }

  if (isAssistantRole(role)) {
    const content = message.content;
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
