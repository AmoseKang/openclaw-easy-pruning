import { describe, expect, it } from "vitest";
import {
  applyPruning,
  applyPruningWithStats,
  normalizeConfig,
  type EasyPruningConfig,
} from "../src/pruner.js";
import {
  applyDetailPruning,
  applyHardPruning,
  applySoftPruning,
  createStrategies,
} from "../src/strategies.js";

const defaults: EasyPruningConfig = {
  pruning_threshold: 100,
  trigger_every_n_tokens: 20,
  keep_recent_tokens: 20,
  keep_recent_messages: 2,
  soft_threshold: 0.3,
  hard_threshold: 0.6,
  detail_threshold: 0.85,
  soft_trim: {
    max_chars: 40,
    head_chars: 10,
    tail_chars: 10,
  },
  hard_clear_placeholder: "[CLEARED]",
  detail_placeholder: "[DETAIL_PRUNED]",
  skip_tools_with_images: true,
  detail_pruning_mode: "default",
  detail_summary_model: undefined,
  detail_summary_max_chars: 120,
  detail_summary_timeout_ms: 3000,
  debug_pruning_io: false,
  debug_summary_io: false,
  debug_preview_chars: 120,
};

describe("normalizeConfig", () => {
  it("supports keep_rencent_message typo alias", () => {
    const cfg = normalizeConfig(defaults, {
      keep_rencent_message: 7,
      keep_recent_messages: undefined,
    });
    expect(cfg.keep_recent_messages).toBe(7);
  });

  it("normalizes detail mode", () => {
    const cfg = normalizeConfig(defaults, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      detail_pruning_mode: "invalid-mode" as any,
    });
    expect(cfg.detail_pruning_mode).toBe("default");
  });
});

describe("strategy functions", () => {
  it("soft pruning keeps head + tail for oversized tool results", () => {
    const msg = { role: "tool_result", content: "A".repeat(100) };
    const out = applySoftPruning(msg, defaults);
    expect(out).not.toBe(msg);
    expect(String(out.content)).toContain("... (truncated)");
    expect(String(out.content)).toContain("Original size");
  });

  it("hard pruning replaces full tool result", () => {
    const msg = { role: "tool_result", content: "Long payload" };
    const out = applyHardPruning(msg, defaults);
    expect(out.content).toBe("[CLEARED]");
  });

  it("detail pruning (default) keeps text blocks for assistant", async () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret" },
        { type: "toolCall", toolName: "read", arguments: { path: "x" } },
        { type: "text", text: "final reply" },
      ],
    };

    const out = await applyDetailPruning(msg, defaults);
    expect(Array.isArray(out.content)).toBe(true);
    const blocks = out.content as Array<{ type: string; text?: string }>;
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toBe("final reply");
  });

  it("detail pruning keep_last_reply keeps only latest assistant text", async () => {
    const cfg = { ...defaults, detail_pruning_mode: "keep_last_reply" as const };
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: "first reply" },
        { type: "toolCall", toolName: "read", arguments: { path: "x" } },
        { type: "text", text: "last reply" },
      ],
    };

    const out = await applyDetailPruning(msg, cfg);
    const serialized = JSON.stringify(out.content);
    expect(serialized).toContain("Last assistant reply kept");
    expect(serialized).toContain("last reply");
  });

  it("detail pruning model_summary uses summary provider", async () => {
    const cfg = { ...defaults, detail_pruning_mode: "model_summary" as const };
    const msg = { role: "assistant", content: "Very long reasoning content here" };

    const out = await applyDetailPruning(msg, cfg, {
      summaryProvider: async () => "Model generated short summary",
    });

    expect(String(out.content)).toContain("Model summary");
    expect(String(out.content)).toContain("Model generated short summary");
  });
});

describe("applyPruning", () => {
  it("protects user and system messages", async () => {
    const messages = [
      { role: "system", content: "SOUL" },
      { role: "user", content: "hello" },
      { role: "tool_result", content: "A".repeat(200) },
      { role: "assistant", content: "ok" },
    ];

    const out = await applyPruning(messages, defaults);
    expect((out[0] as { content: string }).content).toBe("SOUL");
    expect((out[1] as { content: string }).content).toBe("hello");
  });

  it("uses absolute token thresholds when >= 1", async () => {
    const cfg: EasyPruningConfig = {
      ...defaults,
      keep_recent_tokens: 0,
      keep_recent_messages: 0,
      soft_threshold: 1,
      hard_threshold: 20,
      detail_threshold: 40,
    };

    const messages = [
      { role: "tool_result", content: "X".repeat(120) },
      { role: "tool_result", content: "Y".repeat(120) },
      { role: "tool_result", content: "Z".repeat(120) },
    ];

    const out = (await applyPruning(messages, cfg)) as Array<{ content: unknown }>;
    expect(typeof out[0].content).toBe("string");
    expect(out.some((m) => String(m.content).includes("CLEARED") || String(m.content).includes("pruned"))).toBe(
      true,
    );
  });

  it("keeps recent tail by keep_recent_messages", async () => {
    const cfg: EasyPruningConfig = {
      ...defaults,
      keep_recent_tokens: 0,
      keep_recent_messages: 3,
    };

    const messages = Array.from({ length: 8 }, (_, i) => ({
      role: "tool_result",
      content: `payload-${i}-` + "A".repeat(80),
    }));

    const out = (await applyPruning(messages, cfg)) as Array<{ content: string }>;
    expect(out[5].content).toContain("payload-5-");
    expect(out[6].content).toContain("payload-6-");
    expect(out[7].content).toContain("payload-7-");
  });

  it("applies model_summary mode via strategy deps", async () => {
    const cfg: EasyPruningConfig = {
      ...defaults,
      detail_pruning_mode: "model_summary",
      keep_recent_tokens: 0,
      keep_recent_messages: 0,
      soft_threshold: 0,
      hard_threshold: 0,
      detail_threshold: 0,
    };

    const messages = [{ role: "assistant", content: "Long chain of thought / process detail" }];

    const strategies = createStrategies(cfg, {
      summaryProvider: async () => "summary by model",
    });

    const out = (await applyPruning(messages, cfg, strategies)) as Array<{ content: unknown }>;
    expect(String(out[0].content)).toContain("summary by model");
  });

  it("returns debug entries when debug_pruning_io is enabled", async () => {
    const cfg: EasyPruningConfig = {
      ...defaults,
      keep_recent_tokens: 0,
      keep_recent_messages: 0,
      soft_threshold: 0,
      hard_threshold: 0,
      detail_threshold: 0,
      debug_pruning_io: true,
      debug_preview_chars: 60,
    };

    const messages = [
      {
        role: "tool_result",
        content: `${"A".repeat(220)}\n\nFinal Answer: done`,
      },
    ];

    const result = await applyPruningWithStats(messages, cfg);
    expect(result.debugEntries.length).toBeGreaterThan(0);
    expect(result.debugEntries[0].zone).toBe("detail");
    expect(result.debugEntries[0].deletedTokens).toBeGreaterThan(0);
  });
});
