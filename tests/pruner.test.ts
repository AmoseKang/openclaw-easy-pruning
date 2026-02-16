import { describe, expect, it } from "vitest";
import { applyPruning, normalizeConfig, type EasyPruningConfig } from "../src/pruner.js";
import { applyDetailPruning, applyHardPruning, applySoftPruning } from "../src/strategies.js";

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
};

describe("normalizeConfig", () => {
  it("supports keep_rencent_message typo alias", () => {
    const cfg = normalizeConfig(defaults, {
      keep_rencent_message: 7,
      keep_recent_messages: undefined,
    });
    expect(cfg.keep_recent_messages).toBe(7);
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

  it("detail pruning for assistant strips non-text blocks", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret" },
        { type: "toolCall", toolName: "read", arguments: { path: "x" } },
        { type: "text", text: "final reply" },
      ],
    };

    const out = applyDetailPruning(msg, defaults);
    expect(Array.isArray(out.content)).toBe(true);
    const blocks = out.content as Array<{ type: string; text?: string }>;
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toBe("final reply");
  });
});

describe("applyPruning", () => {
  it("protects user and system messages", () => {
    const messages = [
      { role: "system", content: "SOUL" },
      { role: "user", content: "hello" },
      { role: "tool_result", content: "A".repeat(200) },
      { role: "assistant", content: "ok" },
    ];

    const out = applyPruning(messages, defaults);
    expect((out[0] as { content: string }).content).toBe("SOUL");
    expect((out[1] as { content: string }).content).toBe("hello");
  });

  it("uses absolute token thresholds when >= 1", () => {
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

    const out = applyPruning(messages, cfg) as Array<{ content: unknown }>;
    expect(typeof out[0].content).toBe("string");
    // at least one message should be hard/detail pruned after thresholds
    expect(out.some((m) => String(m.content).includes("CLEARED") || String(m.content).includes("pruned"))).toBe(
      true,
    );
  });

  it("keeps recent tail by keep_recent_messages", () => {
    const cfg: EasyPruningConfig = {
      ...defaults,
      keep_recent_tokens: 0,
      keep_recent_messages: 3,
    };

    const messages = Array.from({ length: 8 }, (_, i) => ({
      role: "tool_result",
      content: `payload-${i}-` + "A".repeat(80),
    }));

    const out = applyPruning(messages, cfg) as Array<{ content: string }>;
    expect(out[5].content).toContain("payload-5-");
    expect(out[6].content).toContain("payload-6-");
    expect(out[7].content).toContain("payload-7-");
  });
});
