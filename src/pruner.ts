import { createStrategies, type StrategyDeps } from "./strategies.js";

export { createStrategies };
export type { StrategyDeps };
export const TOKENS_PER_CHAR_ESTIMATE = 4;

export type Logger = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

// Shared caches for llm_input/llm_output-driven trigger logic
export const sessionModelCache = new Map<string, string>(); // sessionKey -> latest model id
export const sessionRealInputTokensCache = new Map<string, number>(); // sessionKey -> latest usage.input_tokens
export const sessionRealInputSourceCache = new Map<string, string>(); // sessionKey -> token source label

export type DetailPruningMode = "default" | "keep_last_reply" | "model_summary";

export type SummaryProvider = (
  input: string,
  options: { role: string; maxChars: number },
) => Promise<string | null>;

export interface EasyPruningConfig {
  pruning_threshold: number;
  trigger_every_n_tokens: number;
  keep_recent_tokens: number;
  keep_recent_messages: number;
  // backward-compatible typo alias accepted in input config only
  keep_rencent_message?: number;
  // threshold supports ratio (0~1) or absolute token position (>=1)
  soft_threshold: number;
  hard_threshold: number;
  detail_threshold: number;
  soft_trim: {
    max_chars: number;
    head_chars: number;
    tail_chars: number;
  };
  hard_clear_placeholder: string;
  detail_placeholder: string;
  skip_tools_with_images: boolean;
  detail_pruning_mode: DetailPruningMode;
  detail_summary_model?: string;
  detail_summary_max_chars: number;
  detail_summary_timeout_ms: number;
  pruning_timeout_ms: number;
  detail_batch_enabled: boolean;
  detail_batch_max_items: number;
  detail_batch_flush_ms: number;
  detail_batch_concurrency: number;
  detail_max_model_items_per_prune: number;
  debug_pruning_io: boolean;
  debug_summary_io: boolean;
  debug_log_file?: string;
  debug_preview_chars: number;
  // optional, for warning-only check in plugin register
  compaction_threshold_hint?: number;
}

export type MessageLike = {
  role?: unknown;
  content?: unknown;
  [key: string]: unknown;
};

export type MessageZone = "none" | "soft" | "hard" | "detail";

export type PruningStats = {
  contextTokensBefore: number;
  contextTokensAfter: number;
  deletedTokens: number;
  totalMessages: number;
  protectedMessages: number;
  changedMessages: number;
  zoneChanged: {
    soft: number;
    hard: number;
    detail: number;
  };
  zoneDeletedTokens: {
    soft: number;
    hard: number;
    detail: number;
  };
};

export type PruningDebugEntry = {
  index: number;
  role: string;
  zone: Exclude<MessageZone, "none">;
  beforeTokens: number;
  afterTokens: number;
  deletedTokens: number;
  beforePreview: string;
  afterPreview: string;
};

type SessionTriggerState = {
  lastTriggerTokenCount: number;
  lastTriggeredAt: number;
  pruneCount: number;
  /**
   * Tracks whether the cooldown baseline came from real usage tokens or estimation.
   * Used to safely rebase when providers start/stop reporting usage fields.
   */
  lastTriggerSource?: "real" | "estimate";
};

type MessageMeta = {
  index: number;
  message: MessageLike;
  role: string;
  tokenCount: number;
  tokenStart: number;
  tokenEnd: number;
  tokenMid: number;
};

// Shared session state (cooldown tracking)
function getSessionState(): Map<string, SessionTriggerState> {
  if (!(globalThis as any).__easy_pruning_session_state) {
    (globalThis as any).__easy_pruning_session_state = new Map<string, SessionTriggerState>();
  }
  return (globalThis as any).__easy_pruning_session_state;
}
const sessionState = getSessionState();

export { getSessionState };
export function normalizeConfig(
  defaults: EasyPruningConfig,
  raw: Partial<EasyPruningConfig> | undefined,
): EasyPruningConfig {
  const input = raw ?? {};

  const keepRecentMessagesRaw =
    typeof input.keep_recent_messages === "number"
      ? input.keep_recent_messages
      : typeof input.keep_rencent_message === "number"
        ? input.keep_rencent_message
        : defaults.keep_recent_messages;

  const cfg: EasyPruningConfig = {
    ...defaults,
    ...input,
    keep_recent_messages: Math.max(0, Math.floor(keepRecentMessagesRaw)),
    soft_trim: {
      ...defaults.soft_trim,
      ...(input.soft_trim ?? {}),
    },
  };

  cfg.pruning_threshold = safePositiveInt(cfg.pruning_threshold, defaults.pruning_threshold);
  cfg.trigger_every_n_tokens = safePositiveInt(
    cfg.trigger_every_n_tokens,
    defaults.trigger_every_n_tokens,
  );
  cfg.keep_recent_tokens = safePositiveInt(cfg.keep_recent_tokens, defaults.keep_recent_tokens);

  cfg.soft_threshold = safeNonNegativeNumber(cfg.soft_threshold, defaults.soft_threshold);
  cfg.hard_threshold = safeNonNegativeNumber(cfg.hard_threshold, defaults.hard_threshold);
  cfg.detail_threshold = safeNonNegativeNumber(cfg.detail_threshold, defaults.detail_threshold);

  cfg.soft_trim.max_chars = safePositiveInt(cfg.soft_trim.max_chars, defaults.soft_trim.max_chars);
  cfg.soft_trim.head_chars = safePositiveInt(cfg.soft_trim.head_chars, defaults.soft_trim.head_chars);
  cfg.soft_trim.tail_chars = safePositiveInt(cfg.soft_trim.tail_chars, defaults.soft_trim.tail_chars);

  cfg.hard_clear_placeholder = String(cfg.hard_clear_placeholder || defaults.hard_clear_placeholder);
  cfg.detail_placeholder = String(cfg.detail_placeholder || defaults.detail_placeholder);

  cfg.detail_pruning_mode = normalizeDetailMode(cfg.detail_pruning_mode, defaults.detail_pruning_mode);
  cfg.detail_summary_max_chars = safePositiveInt(
    cfg.detail_summary_max_chars,
    defaults.detail_summary_max_chars,
  );
  cfg.detail_summary_timeout_ms = safePositiveInt(
    cfg.detail_summary_timeout_ms,
    defaults.detail_summary_timeout_ms!,
  );
  cfg.pruning_timeout_ms = safePositiveInt(
    cfg.pruning_timeout_ms,
    defaults.pruning_timeout_ms!,
  );
  cfg.detail_batch_enabled = Boolean(cfg.detail_batch_enabled);
  cfg.detail_batch_max_items = safePositiveInt(
    cfg.detail_batch_max_items,
    defaults.detail_batch_max_items!,
  );
  cfg.detail_batch_flush_ms = safePositiveInt(
    cfg.detail_batch_flush_ms,
    defaults.detail_batch_flush_ms!,
  );
  cfg.detail_batch_concurrency = safePositiveInt(
    cfg.detail_batch_concurrency,
    defaults.detail_batch_concurrency!,
  );
  cfg.detail_max_model_items_per_prune = safePositiveInt(
    cfg.detail_max_model_items_per_prune,
    defaults.detail_max_model_items_per_prune!,
  );
  cfg.debug_log_file = typeof cfg.debug_log_file === "string" && cfg.debug_log_file.trim() !== ""
    ? cfg.debug_log_file.trim()
    : undefined;
  cfg.debug_preview_chars = safePositiveInt(cfg.debug_preview_chars, defaults.debug_preview_chars);
  cfg.debug_pruning_io = Boolean(cfg.debug_pruning_io);
  cfg.debug_summary_io = Boolean(cfg.debug_summary_io);

  if (typeof cfg.detail_summary_model === "string" && cfg.detail_summary_model.trim().length === 0) {
    cfg.detail_summary_model = undefined;
  }

  return cfg;
}

export async function applyPruning(
  messages: unknown[],
  config: EasyPruningConfig,
  strategies = createStrategies(config),
): Promise<unknown[]> {
  const result = await applyPruningWithStats(messages, config, strategies);
  return result.messages;
}

export async function applyPruningWithStats(
  messages: unknown[],
  config: EasyPruningConfig,
  strategies = createStrategies(config),
): Promise<{ messages: unknown[]; stats: PruningStats; debugEntries: PruningDebugEntry[] }> {
  const metas = buildMessageMeta(messages);
  const beforeTokens = metas.length > 0 ? metas[metas.length - 1].tokenEnd : 0;

  const emptyStats: PruningStats = {
    contextTokensBefore: beforeTokens,
    contextTokensAfter: beforeTokens,
    deletedTokens: 0,
    totalMessages: messages.length,
    protectedMessages: 0,
    changedMessages: 0,
    zoneChanged: { soft: 0, hard: 0, detail: 0 },
    zoneDeletedTokens: { soft: 0, hard: 0, detail: 0 },
  };

  if (metas.length === 0) {
    return { messages, stats: emptyStats, debugEntries: [] };
  }

  const totalTokens = metas[metas.length - 1].tokenEnd;
  const keepRecentStartToken = Math.max(0, totalTokens - config.keep_recent_tokens);
  const keepRecentMessageStartIndex = Math.max(0, messages.length - config.keep_recent_messages);

  const protectedIndices = new Set<number>();

  for (const meta of metas) {
    if (meta.role === "user" || meta.role === "system") {
      protectedIndices.add(meta.index);
      continue;
    }

    if (meta.index >= keepRecentMessageStartIndex) {
      protectedIndices.add(meta.index);
      continue;
    }

    if (meta.tokenStart >= keepRecentStartToken) {
      protectedIndices.add(meta.index);
      continue;
    }
  }

  // Keep thresholds ordered. Supports ratio (<1) and absolute tokens (>=1).
  let softStart = resolveThresholdToToken(config.soft_threshold, totalTokens);
  let hardStart = resolveThresholdToToken(config.hard_threshold, totalTokens);
  let detailStart = resolveThresholdToToken(config.detail_threshold, totalTokens);

  if (hardStart < softStart) {
    hardStart = softStart;
  }
  if (detailStart < hardStart) {
    detailStart = hardStart;
  }

  const prunableEndToken = keepRecentStartToken;

  let changed = false;
  const out = messages.slice();

  const stats: PruningStats = {
    ...emptyStats,
    protectedMessages: protectedIndices.size,
  };

  const debugEntries: PruningDebugEntry[] = [];

  // Limit model-summary calls per pruning pass. Overflow items fall back to default detail pruning.
  const modelSummaryLimit = Math.max(0, Math.floor(config.detail_max_model_items_per_prune ?? 0));
  const fallbackDetailStrategies =
    config.detail_pruning_mode === "model_summary"
      ? createStrategies({ ...config, detail_pruning_mode: "default" })
      : null;
  let modelSummaryUsed = 0;

  for (const meta of metas) {
    if (protectedIndices.has(meta.index)) {
      continue;
    }

    if (meta.tokenMid >= prunableEndToken) {
      continue;
    }

    const zone = resolveZone(meta.tokenMid, softStart, hardStart, detailStart);
    if (zone === "none") {
      continue;
    }

    const original = meta.message;

    const next = await (async () => {
      if (zone !== "detail") {
        return await strategies[zone].apply(original, { config, zone });
      }

      if (config.detail_pruning_mode !== "model_summary") {
        return await strategies.detail.apply(original, { config, zone });
      }

      if (modelSummaryUsed < modelSummaryLimit) {
        modelSummaryUsed += 1;
        return await strategies.detail.apply(original, { config, zone });
      }

      // overflow: fallback to default detail pruning (no model summary)
      if (fallbackDetailStrategies) {
        return await fallbackDetailStrategies.detail.apply(original, { config, zone });
      }

      return await strategies.detail.apply(original, { config, zone });
    })();

    if (next !== original) {
      out[meta.index] = next;
      changed = true;

      const before = estimateMessageTokens(original);
      const after = estimateMessageTokens(next as MessageLike);
      const delta = Math.max(0, before - after);

      stats.changedMessages += 1;
      stats.zoneChanged[zone] += 1;
      stats.zoneDeletedTokens[zone] += delta;

      if (config.debug_pruning_io) {
        debugEntries.push({
          index: meta.index,
          role: meta.role,
          zone,
          beforeTokens: before,
          afterTokens: after,
          deletedTokens: delta,
          beforePreview: previewMessageContent(original.content, config.debug_preview_chars),
          afterPreview: previewMessageContent((next as MessageLike).content, config.debug_preview_chars),
        });
      }
    }
  }

  if (!changed) {
    return { messages, stats, debugEntries };
  }

  const afterTokens = estimateContextTokens(out);
  stats.contextTokensAfter = afterTokens;
  stats.deletedTokens = Math.max(0, stats.contextTokensBefore - afterTokens);

  return { messages: out, stats, debugEntries };
}

function resolveZone(
  tokenMid: number,
  softStart: number,
  hardStart: number,
  detailStart: number,
): MessageZone {
  if (tokenMid < softStart) {
    return "none";
  }
  if (tokenMid < hardStart) {
    return "soft";
  }
  if (tokenMid < detailStart) {
    return "hard";
  }
  return "detail";
}

function resolveThresholdToToken(value: number, totalTokens: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  if (value < 1) {
    return Math.floor(totalTokens * value);
  }
  return Math.min(totalTokens, Math.floor(value));
}

function buildMessageMeta(messages: unknown[]): MessageMeta[] {
  const metas: MessageMeta[] = [];
  let cursor = 0;

  for (let i = 0; i < messages.length; i++) {
    const raw = messages[i];
    if (!raw || typeof raw !== "object") {
      continue;
    }

    const message = raw as MessageLike;
    const tokenCount = Math.max(1, estimateMessageTokens(message));

    const tokenStart = cursor;
    const tokenEnd = tokenStart + tokenCount;
    const tokenMid = tokenStart + tokenCount / 2;

    metas.push({
      index: i,
      message,
      role: String(message.role ?? ""),
      tokenCount,
      tokenStart,
      tokenEnd,
      tokenMid,
    });

    cursor = tokenEnd;
  }

  return metas;
}

function estimateMessageTokens(message: MessageLike): number {
  const roleWeight = typeof message.role === "string" ? message.role.length : 0;
  const contentWeight = estimateUnknownChars(message.content);
  // keep a small fixed overhead per message
  const chars = roleWeight + contentWeight + 16;
  return Math.ceil(chars / TOKENS_PER_CHAR_ESTIMATE);
}

function estimateUnknownChars(input: unknown): number {
  if (input == null) {
    return 0;
  }

  if (typeof input === "string") {
    return input.length;
  }

  if (typeof input === "number" || typeof input === "boolean") {
    return String(input).length;
  }

  if (Array.isArray(input)) {
    return input.reduce<number>((sum, item) => sum + estimateUnknownChars(item), 0);
  }

  if (typeof input === "object") {
    try {
      return JSON.stringify(input).length;
    } catch {
      return 128;
    }
  }

  return 0;
}

function estimateContextTokens(messages: unknown[]): number {
  return messages.reduce<number>((sum, raw) => {
    if (!raw || typeof raw !== "object") {
      return sum;
    }
    return sum + estimateMessageTokens(raw as MessageLike);
  }, 0);
}

function safePositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function safePositiveNumber(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function safeNonNegativeNumber(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return value;
}

function normalizeDetailMode(value: unknown, fallback: DetailPruningMode): DetailPruningMode {
  if (value === "default" || value === "keep_last_reply" || value === "model_summary") {
    return value;
  }
  return fallback;
}

function sameArrayShallow(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }

  return true;
}

function previewMessageContent(content: unknown, maxChars: number): string {
  let raw = "";

  if (typeof content === "string") {
    raw = content;
  } else {
    try {
      raw = JSON.stringify(content);
    } catch {
      raw = String(content ?? "");
    }
  }

  const compact = raw.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  if (maxChars <= 3) {
    return compact.slice(0, Math.max(0, maxChars));
  }
  return `${compact.slice(0, maxChars - 3)}...`;
}

export { estimateContextTokens, sameArrayShallow };
export {
  createBeforeAgentStartHandler,
  createLlmInputHandler,
  createLlmOutputHandler,
} from "./handlers/index.js";
