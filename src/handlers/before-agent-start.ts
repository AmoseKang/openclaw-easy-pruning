import type { EasyPruningConfig, Logger, StrategyDeps } from "../pruner.js";
import {
  createStrategies,
  applyPruningWithStats,
  estimateContextTokens,
  getSessionState,
  sameArrayShallow,
  sessionModelCache,
  sessionRealInputTokensCache,
  sessionRealInputSourceCache,
} from "../pruner.js";

export function createBeforeAgentStartHandler(
  config: EasyPruningConfig,
  logger: Logger,
  deps?: StrategyDeps,
) {
  // Reset caches on init (hot reload safety)
  getSessionState().clear();
  sessionModelCache.clear();
  sessionRealInputTokensCache.clear();
  sessionRealInputSourceCache.clear();

  const strategies = createStrategies(config, {
    logger,
    summaryProvider: deps?.summaryProvider,
  });

  const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("pruning_timeout")), timeoutMs),
    );
    return (await Promise.race([promise, timeout])) as T;
  };

  return async (
    event: { messages?: unknown[] },
    ctx: { sessionKey?: string; sessionId?: string },
  ) => {
    if (!Array.isArray(event.messages) || event.messages.length === 0) {
      return;
    }

    const messages = event.messages;
    const key = ctx.sessionKey || ctx.sessionId || "__global__";

    const realInputTokens = sessionRealInputTokensCache.get(key);
    const usageSource = sessionRealInputSourceCache.get(key) ?? "unknown";
    const model = sessionModelCache.get(key) ?? "(unknown)";

    // Prefer real usage tokens; fall back to deterministic estimation so pruning can work
    // on providers/models that don't emit usage.input_tokens.
    let inputTokens = realInputTokens ?? 0;
    let tokenSource = usageSource;
    let triggerMode: "real" | "estimate" = "real";

    if (!inputTokens || inputTokens <= 0) {
      inputTokens = estimateContextTokens(messages);
      tokenSource = "estimate.context";
      triggerMode = "estimate";
      logger.info?.(
        `[EasyPruning][Gateway] usage missing; fallback to estimate session=${key} model=${model} est_input_tokens=${inputTokens}t threshold=${config.pruning_threshold}t`,
      );
    }

    if (!inputTokens || inputTokens <= 0) {
      logger.info?.(
        `[EasyPruning][Gateway] skip session=${key} model=${model} reason=no_tokens threshold=${config.pruning_threshold}t`,
      );
      return;
    }

    logger.info?.(
      `[EasyPruning][Gateway] session=${key} model=${model} input_tokens=${inputTokens}t mode=${triggerMode} source=${tokenSource} threshold=${config.pruning_threshold}t triggerEvery=${config.trigger_every_n_tokens}t`,
    );

    if (inputTokens < config.pruning_threshold) {
      logger.info?.(
        `[EasyPruning][Gateway] skip session=${key} reason=below_threshold input_tokens=${inputTokens}t threshold=${config.pruning_threshold}t mode=${triggerMode}`,
      );
      return;
    }

    const state = getSessionState().get(key) ?? {
      lastTriggerTokenCount: 0,
      lastTriggeredAt: 0,
      pruneCount: 0,
    };

    if (state.lastTriggerSource && state.lastTriggerSource !== triggerMode) {
      logger.info?.(
        `[EasyPruning][Gateway] cooldown baseline source changed; rebasing session=${key} from=${state.lastTriggerSource} to=${triggerMode} baseline=${inputTokens}t`,
      );
      state.lastTriggerTokenCount = inputTokens;
      state.lastTriggerSource = triggerMode;
      state.pruneCount = 0;
    }

    if (state.lastTriggerTokenCount > inputTokens) {
      logger.info?.(
        `[EasyPruning][Gateway] cooldown baseline rebased session=${key} from=${state.lastTriggerTokenCount}t to=${inputTokens}t mode=${triggerMode}`,
      );
      state.lastTriggerTokenCount = inputTokens;
      state.pruneCount = 0;
    }

    const tokensSinceLast = Math.max(0, inputTokens - state.lastTriggerTokenCount);
    if (state.pruneCount > 0 && tokensSinceLast < config.trigger_every_n_tokens) {
      logger.info?.(
        `[EasyPruning][Gateway] skip session=${key} reason=cooldown input_tokens=${inputTokens}t since_last_trigger=${tokensSinceLast}t required=${config.trigger_every_n_tokens}t mode=${triggerMode}`,
      );
      return;
    }

    let result: {
      messages: unknown[];
      stats: import("../pruner.js").PruningStats;
      debugEntries: import("../pruner.js").PruningDebugEntry[];
    };
    try {
      result = await withTimeout(
        applyPruningWithStats(messages, config, strategies),
        config.pruning_timeout_ms,
      );
    } catch (error) {
      const needsFallback =
        config.detail_pruning_mode === "model_summary" && String(error).includes("pruning_timeout");
      if (!needsFallback) {
        logger.warn?.(`[EasyPruning][Gateway] pruning timeout session=${key}: ${String(error)}`);
        return;
      }

      logger.warn?.(
        `[EasyPruning][Gateway] pruning timeout session=${key} timeout=${config.pruning_timeout_ms}ms; fallback detail_pruning_mode=default`,
      );

      const fallbackConfig: EasyPruningConfig = {
        ...config,
        detail_pruning_mode: "default",
      };
      const fallbackStrategies = createStrategies(fallbackConfig, { logger });
      result = await applyPruningWithStats(messages, fallbackConfig, fallbackStrategies);
    }

    const changed = !sameArrayShallow(messages, result.messages);

    state.lastTriggerTokenCount = inputTokens;
    state.lastTriggerSource = triggerMode;
    state.lastTriggeredAt = Date.now();
    if (changed) {
      state.pruneCount += 1;
    }
    getSessionState().set(key, state);

    if (!changed) {
      logger.info?.(
        `[EasyPruning][Gateway] prune-check session=${key} triggered=true changed=0 reason=no_eligible_messages input_tokens=${inputTokens}t mode=${triggerMode}`,
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
      `[EasyPruning][Gateway] prune#${state.pruneCount} session=${key} triggered=true input_tokens=${inputTokens}t mode=${triggerMode} before=${result.stats.contextTokensBefore}t after=${result.stats.contextTokensAfter}t deleted=${result.stats.deletedTokens}t (${pct}%) changed=${result.stats.changedMessages}msg ` +
        `[soft:${result.stats.zoneChanged.soft}/-${result.stats.zoneDeletedTokens.soft}t hard:${result.stats.zoneChanged.hard}/-${result.stats.zoneDeletedTokens.hard}t detail:${result.stats.zoneChanged.detail}/-${result.stats.zoneDeletedTokens.detail}t]`,
    );

    if (config.debug_pruning_io && result.debugEntries.length > 0) {
      logger.info?.(
        `[EasyPruning][Debug] session=${key} prune#${state.pruneCount} entries=${JSON.stringify(result.debugEntries)}`,
      );
    }
  };
}
