import type { EasyPruningConfig, Logger } from "../pruner.js";
import {
  sessionModelCache,
  sessionRealInputTokensCache,
  sessionRealInputSourceCache,
} from "../pruner.js";

type NumWithSource = { value: number; source: string };
const MAX_REASONABLE_INPUT_TOKENS = 2_000_000;

function pickNumber(obj: unknown, paths: string[]): NumWithSource | null {
  if (!obj || typeof obj !== "object") {
    return null;
  }

  for (const path of paths) {
    const parts = path.split(".");
    let cursor: unknown = obj;
    for (const part of parts) {
      if (!cursor || typeof cursor !== "object") {
        cursor = undefined;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[part];
    }

    if (cursor == null) continue;

    const n = typeof cursor === "number" ? cursor : Number(cursor);
    if (Number.isFinite(n) && n > 0) {
      return { value: Math.floor(n), source: path };
    }
  }

  return null;
}

function resolveSessionKey(ctx: Record<string, unknown>): string {
  const key = String(ctx.sessionKey || ctx.sessionId || "__global__").trim();
  return key || "__global__";
}

function resolveInputTokens(event: Record<string, unknown>): NumWithSource | null {
  const usage = event.usage;
  const usageHit = pickNumber(usage, [
    "input",
    "prompt",
    "input_tokens",
    "prompt_tokens",
    "inputTokenCount",
    "promptTokenCount",
    "tokens.input",
    "tokens.prompt",
  ]);
  if (usageHit) {
    return { value: usageHit.value, source: `usage.${usageHit.source}` };
  }

  const topHit = pickNumber(event, [
    "input",
    "prompt",
    "input_tokens",
    "prompt_tokens",
    "inputTokenCount",
    "promptTokenCount",
  ]);
  if (topHit) {
    return topHit;
  }

  return null;
}

/**
 * LLM output hook handler - source of truth for real input tokens (usage).
 */
export function createLlmOutputHandler(config: EasyPruningConfig, logger: Logger) {
  return (
    rawEvent: { usage?: unknown; model?: string; [key: string]: unknown },
    rawCtx: { sessionKey?: string; sessionId?: string; [key: string]: unknown },
  ) => {
    const event = rawEvent as Record<string, unknown>;
    const ctx = rawCtx as Record<string, unknown>;

    const sessionKey = resolveSessionKey(ctx);
    const model =
      (typeof event.model === "string" ? event.model : undefined) ||
      sessionModelCache.get(sessionKey) ||
      "(unknown)";

    const tokenInfo = resolveInputTokens(event);
    if (!tokenInfo) {
      if (config.debug_summary_io) {
        logger.debug?.(
          `[EasyPruning][Gateway] llm_output skip session=${sessionKey} model=${model} reason=no_usage_input_tokens`,
        );
      }
      return;
    }

    if (tokenInfo.value <= 0 || tokenInfo.value > MAX_REASONABLE_INPUT_TOKENS) {
      logger.warn?.(
        `[EasyPruning][Gateway] llm_output drop_outlier session=${sessionKey} model=${model} input_tokens=${tokenInfo.value} source=${tokenInfo.source}`,
      );
      return;
    }

    sessionRealInputTokensCache.set(sessionKey, tokenInfo.value);
    sessionRealInputSourceCache.set(sessionKey, tokenInfo.source);

    if (typeof event.model === "string") {
      sessionModelCache.set(sessionKey, event.model);
    }

    logger.info?.(
      `[EasyPruning][Gateway] usage_update session=${sessionKey} model=${model} real_input_tokens=${tokenInfo.value} source=${tokenInfo.source} threshold=${config.pruning_threshold}t triggerEvery=${config.trigger_every_n_tokens}t`,
    );
  };
}
