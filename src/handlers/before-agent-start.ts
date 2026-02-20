import type { EasyPruningConfig, Logger, StrategyDeps } from "../pruner.js";
import {
  createStrategies,
  applyPruningWithStats,
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
    const tokenSource = sessionRealInputSourceCache.get(key) ?? "unknown";
    const model = sessionModelCache.get(key) ?? "(unknown)";

    if (!realInputTokens || realInputTokens <= 0) {
      logger.info?.(
        `[EasyPruning][Gateway] skip session=${key} model=${model} reason=no_usage_tokens threshold=${config.pruning_threshold}t`,
      );
      return;
    }

    logger.info?.(
      `[EasyPruning][Gateway] session=${key} model=${model} real_input_tokens=${realInputTokens} source=${tokenSource} threshold=${config.pruning_threshold}t triggerEvery=${config.trigger_every_n_tokens}t`,
    );

    if (realInputTokens < config.pruning_threshold) {
      logger.info?.(
        `[EasyPruning][Gateway] skip session=${key} reason=below_threshold real_input_tokens=${realInputTokens}t threshold=${config.pruning_threshold}t`,
      );
      return;
    }

    const state = getSessionState().get(key) ?? {
      lastTriggerTokenCount: 0,
      lastTriggeredAt: 0,
      pruneCount: 0,
    };

    if (state.lastTriggerTokenCount > realInputTokens) {
      logger.info?.(
        `[EasyPruning][Gateway] cooldown baseline rebased session=${key} from=${state.lastTriggerTokenCount}t to=${realInputTokens}t`,
      );
      state.lastTriggerTokenCount = realInputTokens;
      state.pruneCount = 0;
    }

    const tokensSinceLast = Math.max(0, realInputTokens - state.lastTriggerTokenCount);
    if (state.pruneCount > 0 && tokensSinceLast < config.trigger_every_n_tokens) {
      logger.info?.(
        `[EasyPruning][Gateway] skip session=${key} reason=cooldown real_input_tokens=${realInputTokens}t since_last_trigger=${tokensSinceLast}t required=${config.trigger_every_n_tokens}t`,
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

    state.lastTriggerTokenCount = realInputTokens;
    state.lastTriggeredAt = Date.now();
    if (changed) {
      state.pruneCount += 1;
    }
    getSessionState().set(key, state);

    if (!changed) {
      logger.info?.(
        `[EasyPruning][Gateway] prune-check session=${key} triggered=true changed=0 reason=no_eligible_messages real_input_tokens=${realInputTokens}t`,
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
      `[EasyPruning][Gateway] prune#${state.pruneCount} session=${key} triggered=true real_input_tokens=${realInputTokens}t before=${result.stats.contextTokensBefore}t after=${result.stats.contextTokensAfter}t deleted=${result.stats.deletedTokens}t (${pct}%) changed=${result.stats.changedMessages}msg ` +
        `[soft:${result.stats.zoneChanged.soft}/-${result.stats.zoneDeletedTokens.soft}t hard:${result.stats.zoneChanged.hard}/-${result.stats.zoneDeletedTokens.hard}t detail:${result.stats.zoneChanged.detail}/-${result.stats.zoneDeletedTokens.detail}t]`,
    );

    if (config.debug_pruning_io && result.debugEntries.length > 0) {
      logger.info?.(
        `[EasyPruning][Debug] session=${key} prune#${state.pruneCount} entries=${JSON.stringify(result.debugEntries)}`,
      );
    }
  };
}
