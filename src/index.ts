import { createBeforeAgentStartHandler, normalizeConfig, type EasyPruningConfig } from "./pruner.js";

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
};

export default {
  id: "easy-pruning",
  name: "Easy Pruning",
  version: "0.2.0",

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

    api.on("before_agent_start", createBeforeAgentStartHandler(config, api.logger));
    api.logger.info("[EasyPruning] plugin registered");
  },
} as const;

export type { EasyPruningConfig };
