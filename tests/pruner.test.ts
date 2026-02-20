import { describe, expect, it } from "vitest";
import {
  applyPruning,
  applyPruningWithStats,
  createBeforeAgentStartHandler,
  createLlmOutputHandler,
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
  detail_summary_timeout_ms: 20000,
  pruning_timeout_ms: 20000,
  detail_batch_enabled: true,
  detail_batch_max_items: 8,
  detail_batch_flush_ms: 10,
  detail_batch_concurrency: 2,
  detail_max_model_items_per_prune: 24,
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

  it("detail pruning (default) preserves toolCall linkage for assistant", async () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret" },
        { type: "toolCall", id: "call_123", name: "read", arguments: { path: "x", data: "A".repeat(500) } },
        { type: "text", text: "final reply" },
      ],
    };

    const out = await applyDetailPruning(msg, defaults);
    expect(Array.isArray(out.content)).toBe(true);
    const blocks = out.content as Array<{ type: string; id?: string; text?: string; arguments?: unknown }>;
    const toolCall = blocks.find((b) => b.type === "toolCall");
    expect(toolCall).toBeTruthy();
    expect(toolCall?.id).toBe("call_123");
    expect(typeof JSON.stringify(toolCall?.arguments)).toBe("string");

    const last = blocks[blocks.length - 1];
    expect(last.type).toBe("text");
    expect(String(last.text)).toContain("final reply");
  });

  it("detail pruning keep_last_reply keeps latest text and preserves toolCall", async () => {
    const cfg = { ...defaults, detail_pruning_mode: "keep_last_reply" as const };
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: "first reply" },
        { type: "toolCall", id: "call_456", name: "read", arguments: { path: "x" } },
        { type: "text", text: "last reply" },
      ],
    };

    const out = await applyDetailPruning(msg, cfg);
    const serialized = JSON.stringify(out.content);
    expect(serialized).toContain("Last assistant reply kept");
    expect(serialized).toContain("last reply");
    expect(serialized).toContain("call_456");
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

  it("detail pruning model_summary preserves toolCall linkage for assistant", async () => {
    const cfg = { ...defaults, detail_pruning_mode: "model_summary" as const };
    const msg = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "long internal reasoning" },
        { type: "toolCall", id: "call_789", name: "web_search", arguments: { query: "A".repeat(500) } },
        { type: "text", text: "long textual explanation" },
      ],
    };

    const out = await applyDetailPruning(msg, cfg, {
      summaryProvider: async () => "summarized assistant context",
    });

    const serialized = JSON.stringify(out.content);
    expect(serialized).toContain("call_789");
    expect(serialized).toContain("Model summary (assistant)");
    expect(serialized).toContain("summarized assistant context");
  });

  it("detail pruning model_summary keeps toolCall-only assistant messages linkable", async () => {
    const cfg = { ...defaults, detail_pruning_mode: "model_summary" as const };
    const msg = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_only", name: "read", arguments: { path: "/tmp/a" } }],
    };

    const out = await applyDetailPruning(msg, cfg, {
      summaryProvider: async () => "",
    });

    const serialized = JSON.stringify(out.content);
    expect(serialized).toContain("call_only");
    expect(serialized).toContain("type\":\"toolCall\"");
  });

  it("detail pruning model_summary skips already summarized content", async () => {
    const cfg = { ...defaults, detail_pruning_mode: "model_summary" as const };
    const msg = {
      role: "tool_result",
      content: "[Model summary (toolResult)]\n\nAlready summarized",
    };

    const out = await applyDetailPruning(msg, cfg, {
      summaryProvider: async () => {
        throw new Error("should not be called");
      },
    });

    expect(out).toBe(msg);
  });

  it("detail pruning preserves function_call style linkage fields", async () => {
    const cfg = { ...defaults, detail_pruning_mode: "model_summary" as const };
    const msg = {
      role: "assistant",
      content: [
        { type: "function_call", call_id: "call_cf876", functionName: "read", input: { path: "/tmp/x" } },
      ],
    };

    const out = await applyDetailPruning(msg, cfg, {
      summaryProvider: async () => "",
    });

    const serialized = JSON.stringify(out.content);
    expect(serialized).toContain("function_call");
    expect(serialized).toContain("call_cf876");
    expect(serialized).toContain("call_id");
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

  it("limits model-summary items per prune and falls back for overflow", async () => {
    const cfg: EasyPruningConfig = {
      ...defaults,
      detail_pruning_mode: "model_summary",
      keep_recent_tokens: 0,
      keep_recent_messages: 0,
      soft_threshold: 0,
      hard_threshold: 0,
      detail_threshold: 0,
      detail_max_model_items_per_prune: 1,
    };

    let calls = 0;
    const strategies = createStrategies(cfg, {
      summaryProvider: async () => {
        calls += 1;
        return "batched summary";
      },
    });

    const messages = [
      { role: "tool_result", content: "Tool output A\n\nFinal Answer: A done" },
      { role: "tool_result", content: "Tool output B\n\nFinal Answer: B done" },
    ];

    const out = (await applyPruning(messages, cfg, strategies)) as Array<{ content: string }>;
    expect(calls).toBe(1);
    expect(out.some((m) => String(m.content).includes("Model summary"))).toBe(true);
    expect(out.some((m) => String(m.content).includes("[Process details pruned]"))).toBe(true);
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

  it("rebases cooldown baseline when real usage shrinks", async () => {
    const cfg: EasyPruningConfig = {
      ...defaults,
      pruning_threshold: 10,
      trigger_every_n_tokens: 50,
      keep_recent_tokens: 0,
      keep_recent_messages: 0,
      soft_threshold: 0,
      hard_threshold: 0,
      detail_threshold: 0,
    };

    const logs: string[] = [];
    const logger = {
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      debug: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
    };

    const beforeHandler = createBeforeAgentStartHandler(cfg, logger);
    const outputHandler = createLlmOutputHandler(cfg, logger);
    const sessionKey = `test:cooldown-rebase:${Date.now()}`;

    outputHandler({ model: "test-model", usage: { input_tokens: 1000 } }, { sessionKey });
    const large = [{ role: "tool_result", content: "A".repeat(1200) }];
    await beforeHandler({ messages: large }, { sessionKey });

    logs.length = 0;
    outputHandler({ model: "test-model", usage: { input_tokens: 200 } }, { sessionKey });
    const smaller = [{ role: "tool_result", content: "B".repeat(300) }];
    await beforeHandler({ messages: smaller }, { sessionKey });

    expect(logs.some((l) => l.includes("cooldown baseline rebased"))).toBe(true);
    expect(logs.some((l) => l.includes("reason=cooldown"))).toBe(false);
  });

  it("falls back to default detail pruning when pruning exceeds pruning_timeout_ms", async () => {
    const cfg: EasyPruningConfig = {
      ...defaults,
      pruning_threshold: 10,
      trigger_every_n_tokens: 1,
      keep_recent_tokens: 0,
      keep_recent_messages: 0,
      soft_threshold: 0,
      hard_threshold: 0,
      detail_threshold: 0,
      detail_pruning_mode: "model_summary",
      pruning_timeout_ms: 5,
      detail_summary_timeout_ms: 1000,
    };

    const logs: string[] = [];
    const logger = {
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      debug: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
    };

    const beforeHandler = createBeforeAgentStartHandler(cfg, logger, {
      summaryProvider: async () => new Promise<string>((resolve) => setTimeout(() => resolve("late"), 200)),
    });
    const outputHandler = createLlmOutputHandler(cfg, logger);
    const sessionKey = `test:timeout-fallback:${Date.now()}`;

    outputHandler({ model: "test-model", usage: { input_tokens: 1200 } }, { sessionKey });
    const messages = [{ role: "tool_result", content: "X".repeat(1200) }];
    await beforeHandler({ messages }, { sessionKey });

    expect(logs.some((l) => l.includes("pruning timeout") && l.includes("fallback detail_pruning_mode=default"))).toBe(true);
    expect(String((messages[0] as { content: unknown }).content)).toContain("[Process details pruned]");
  });

  it("uses llm_output real_input_tokens for threshold check and logging", async () => {
    const cfg: EasyPruningConfig = {
      ...defaults,
      pruning_threshold: 300,
      trigger_every_n_tokens: 1,
      keep_recent_tokens: 0,
      keep_recent_messages: 0,
      soft_threshold: 0,
      hard_threshold: 0,
      detail_threshold: 0,
    };

    const logs: string[] = [];
    const logger = {
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      debug: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
    };

    const beforeHandler = createBeforeAgentStartHandler(cfg, logger);
    const outputHandler = createLlmOutputHandler(cfg, logger);
    const sessionKey = `test:usage-threshold:${Date.now()}`;

    outputHandler({ model: "test-model", usage: { input_tokens: 420 } }, { sessionKey });
    const messages = [{ role: "tool_result", content: "X".repeat(300) }];
    await beforeHandler({ messages }, { sessionKey });

    expect(logs.some((l) => l.includes("usage_update") && l.includes("real_input_tokens=420"))).toBe(true);
    expect(logs.some((l) => l.includes("real_input_tokens=420") && l.includes("threshold=300"))).toBe(true);
    expect(logs.some((l) => l.includes("reason=below_threshold"))).toBe(false);
  });
});
