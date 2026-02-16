import {
  createBeforeAgentStartHandler,
  normalizeConfig,
  type EasyPruningConfig,
  type Logger,
  type SummaryProvider,
} from "./pruner.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const defaultConfig: EasyPruningConfig = {
  pruning_threshold: 80_000,
  trigger_every_n_tokens: 5_000,
  keep_recent_tokens: 10_000,
  keep_recent_messages: 10,
  soft_threshold: 0.7,
  hard_threshold: 0.85,
  detail_threshold: 0.95,
  soft_trim: {
    max_chars: 4_000,
    head_chars: 1_500,
    tail_chars: 1_500,
  },
  hard_clear_placeholder: "[Old tool result content cleared]",
  detail_placeholder: "[Detailed execution context pruned to save tokens]",
  skip_tools_with_images: true,
  detail_pruning_mode: "default",
  detail_summary_model: undefined,
  detail_summary_max_chars: 600,
  detail_summary_timeout_ms: 8000,
  debug_pruning_io: false,
  debug_summary_io: false,
  debug_preview_chars: 240,
};

export default {
  id: "easy-pruning",
  name: "OpenClaw Easy Pruning",
  version: "0.3.1",

  register(api: AnyApi) {
    const rawConfig =
      (api.pluginConfig as Partial<EasyPruningConfig> | undefined) ??
      (api.config?.plugins?.entries?.["easy-pruning"]?.config as Partial<EasyPruningConfig> | undefined) ??
      {};

    const config = normalizeConfig(defaultConfig, rawConfig);

    // Best-effort warning: if user provides a compaction hint, pruning should happen earlier.
    if (
      typeof config.compaction_threshold_hint === "number" &&
      Number.isFinite(config.compaction_threshold_hint) &&
      config.compaction_threshold_hint > 0 &&
      config.pruning_threshold >= config.compaction_threshold_hint
    ) {
      api.logger.warn(
        `[EasyPruning] pruning_threshold (${config.pruning_threshold}) should be lower than compaction_threshold_hint (${config.compaction_threshold_hint})`,
      );
    }

    const summaryProvider = createSummaryProvider(api, config, api.logger);

    api.on(
      "before_agent_start",
      createBeforeAgentStartHandler(config, api.logger, {
        summaryProvider,
      }),
    );

    api.logger.info(
      `[EasyPruning] plugin registered (detail_pruning_mode=${config.detail_pruning_mode}${
        summaryProvider ? ", model_summary_provider=on" : ""
      }${
        config.debug_pruning_io || config.debug_summary_io
          ? `, debug_pruning_io=${config.debug_pruning_io}, debug_summary_io=${config.debug_summary_io}`
          : ""
      })`,
    );
  },
} as const;

function createSummaryProvider(
  api: AnyApi,
  config: EasyPruningConfig,
  logger: Logger,
): SummaryProvider | undefined {
  if (config.detail_pruning_mode !== "model_summary") {
    return undefined;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candidates: Array<{ name: string; call: (prompt: string) => Promise<any> }> = [];

  if (typeof api.generateText === "function") {
    candidates.push({
      name: "generateText",
      call: async (prompt) =>
        api.generateText({
          prompt,
          model: config.detail_summary_model,
          maxTokens: 280,
        }),
    });
  }

  if (typeof api.callModel === "function") {
    candidates.push({
      name: "callModel",
      call: async (prompt) =>
        api.callModel({
          prompt,
          model: config.detail_summary_model,
          maxTokens: 280,
        }),
    });
  }

  if (typeof api.ask === "function") {
    candidates.push({
      name: "ask",
      call: async (prompt) => api.ask(prompt, { model: config.detail_summary_model }),
    });
  }

  if (candidates.length === 0) {
    logger.warn?.("[EasyPruning] detail_pruning_mode=model_summary configured but no model API found; fallback to heuristic summary");
    return undefined;
  }

  return async (input, options) => {
    const prompt = [
      "Summarize the following OpenClaw context block for future turns.",
      "Keep only key user-facing outcomes, errors, and decisions.",
      `Output plain text within ${options.maxChars} characters.`,

      `Role: ${options.role}`,
      "---",
      input,
    ].join("\n");

    for (const candidate of candidates) {
      try {
        const response = await withTimeout(candidate.call(prompt), config.detail_summary_timeout_ms);
        const text = extractText(response);
        if (text && text.trim()) {
          const summary = text.trim().slice(0, options.maxChars);
          if (config.debug_summary_io) {
            logger.info?.(
              `[EasyPruning][Debug] summary_api=${candidate.name} model=${config.detail_summary_model ?? "(default)"} role=${options.role} prompt=${previewText(prompt, config.debug_preview_chars)} output=${previewText(summary, config.debug_preview_chars)}`,
            );
          }
          return summary;
        }
      } catch (error) {
        if (config.debug_summary_io) {
          logger.warn?.(
            `[EasyPruning][Debug] summary_api=${candidate.name} failed: ${String(error)}`,
          );
        }
      }
    }

    return null;
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractText(value: any): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  if (typeof value.text === "string") {
    return value.text;
  }

  if (Array.isArray(value.content)) {
    const parts: string[] = [];
    for (const block of value.content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      if (typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }

  if (typeof value.output_text === "string") {
    return value.output_text;
  }

  return null;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  return Promise.race([promise, timeout]);
}

function previewText(input: string, maxChars: number): string {
  const compact = input.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  if (maxChars <= 3) {
    return compact.slice(0, Math.max(0, maxChars));
  }
  return `${compact.slice(0, maxChars - 3)}...`;
}

export type { EasyPruningConfig };
