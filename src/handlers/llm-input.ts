import type { Logger } from "../pruner.js";
import { sessionModelCache } from "../pruner.js";

function resolveSessionKey(ctx: Record<string, unknown>): string {
  const key = String(ctx.sessionKey || ctx.sessionId || "__global__").trim();
  return key || "__global__";
}

/**
 * LLM input hook handler - keep latest model per session for logging/diagnostics.
 */
export function createLlmInputHandler(logger: Logger) {
  return (
    rawEvent: { model?: string; [key: string]: unknown },
    rawCtx: { sessionKey?: string; sessionId?: string; [key: string]: unknown },
  ) => {
    const event = rawEvent as Record<string, unknown>;
    const ctx = rawCtx as Record<string, unknown>;

    const sessionKey = resolveSessionKey(ctx);
    const model = typeof event.model === "string" ? event.model : undefined;

    if (!model) {
      logger.debug?.(
        `[EasyPruning][Gateway] llm_input session=${sessionKey} model=(unknown)`,
      );
      return;
    }

    sessionModelCache.set(sessionKey, model);
    logger.debug?.(
      `[EasyPruning][Gateway] llm_input session=${sessionKey} model=${model}`,
    );
  };
}
