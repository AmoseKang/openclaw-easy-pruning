import { createStrategies } from "./strategies.js";

export type Logger = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

const TOKENS_PER_CHAR_ESTIMATE = 4;

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

type SessionTriggerState = {
  lastTriggerTokenCount: number;
  lastTriggeredAt: number;
  pruneCount: number;
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

const sessionState = new Map<string, SessionTriggerState>();

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

  return cfg;
}

export function createBeforeAgentStartHandler(config: EasyPruningConfig, logger: Logger) {
  const strategies = createStrategies(config);

  return async (
    event: { messages?: unknown[] },
    ctx: { sessionKey?: string; sessionId?: string },
  ) => {
    if (!Array.isArray(event.messages) || event.messages.length === 0) {
      return;
    }

    const messages = event.messages;
    const totalTokens = estimateContextTokens(messages);
    const key = ctx.sessionKey || ctx.sessionId || "__global__";

    logger.info?.(
      `[EasyPruning][Gateway] session=${key} context=${totalTokens}t threshold=${config.pruning_threshold}t triggerEvery=${config.trigger_every_n_tokens}t`,
    );

    if (totalTokens < config.pruning_threshold) {
      logger.debug?.(
        `[EasyPruning][Gateway] skip: below threshold (context=${totalTokens}t < threshold=${config.pruning_threshold}t)`,
      );
      return;
    }

    const state = sessionState.get(key) ?? {
      lastTriggerTokenCount: 0,
      lastTriggeredAt: 0,
      pruneCount: 0,
    };

    const tokensSinceLast = Math.max(0, totalTokens - state.lastTriggerTokenCount);
    if (state.pruneCount > 0 && tokensSinceLast < config.trigger_every_n_tokens) {
      logger.info?.(
        `[EasyPruning][Gateway] skip: cooldown session=${key} context=${totalTokens}t grew=${tokensSinceLast}t required=${config.trigger_every_n_tokens}t`,
      );
      return;
    }

    const result = applyPruningWithStats(messages, config, strategies);
    const changed = !sameArrayShallow(messages, result.messages);

    // Update trigger state whenever a pruning check is performed at threshold.
    state.lastTriggerTokenCount = totalTokens;
    state.lastTriggeredAt = Date.now();
    if (changed) {
      state.pruneCount += 1;
    }
    sessionState.set(key, state);

    if (!changed) {
      logger.info?.(
        `[EasyPruning][Gateway] prune-check: no eligible messages session=${key} context=${totalTokens}t deleted=0t changed=0msg`,
      );
      return;
    }

    messages.length = 0;
    messages.push(...result.messages);

    const pct =
      result.stats.contextTokensBefore > 0
        ? ((result.stats.deletedTokens / result.stats.contextTokensBefore) * 100).toFixed(1)
        : "0.0";

    logger.info?.(
      `[EasyPruning][Gateway] prune#${state.pruneCount} session=${key} before=${result.stats.contextTokensBefore}t after=${result.stats.contextTokensAfter}t deleted=${result.stats.deletedTokens}t (${pct}%) changed=${result.stats.changedMessages}msg ` +
        `[soft:${result.stats.zoneChanged.soft}/-${result.stats.zoneDeletedTokens.soft}t hard:${result.stats.zoneChanged.hard}/-${result.stats.zoneDeletedTokens.hard}t detail:${result.stats.zoneChanged.detail}/-${result.stats.zoneDeletedTokens.detail}t]`,
    );
  };
}

export function applyPruning(
  messages: unknown[],
  config: EasyPruningConfig,
  strategies = createStrategies(config),
): unknown[] {
  return applyPruningWithStats(messages, config, strategies).messages;
}

export function applyPruningWithStats(
  messages: unknown[],
  config: EasyPruningConfig,
  strategies = createStrategies(config),
): { messages: unknown[]; stats: PruningStats } {
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
    return { messages, stats: emptyStats };
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
    const next = strategies[zone].apply(original, { config, zone });

    if (next !== original) {
      out[meta.index] = next;
      changed = true;

      const before = estimateMessageTokens(original);
      const after = estimateMessageTokens(next as MessageLike);
      const delta = Math.max(0, before - after);

      stats.changedMessages += 1;
      stats.zoneChanged[zone] += 1;
      stats.zoneDeletedTokens[zone] += delta;
    }
  }

  if (!changed) {
    return { messages, stats };
  }

  const afterTokens = estimateContextTokens(out);
  stats.contextTokensAfter = afterTokens;
  stats.deletedTokens = Math.max(0, stats.contextTokensBefore - afterTokens);

  return { messages: out, stats };
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

function safeNonNegativeNumber(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return value;
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
