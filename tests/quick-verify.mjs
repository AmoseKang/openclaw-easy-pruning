#!/usr/bin/env node

/**
 * Quick sanity check for the new v0.3.6 flow.
 *
 * It simulates:
 *  - llm_input (model cache)
 *  - llm_output (real input token usage cache)
 *  - before_agent_start (trigger + cooldown)
 *
 * Usage:
 *   npm run build
 *   node tests/quick-verify.mjs
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs";

const distDir = path.join(process.cwd(), "dist");

function mustExist(rel) {
  const p = path.join(distDir, rel);
  if (!fs.existsSync(p)) {
    throw new Error(`Missing dist file: ${p}. Did you run: npm run build ?`);
  }
  return p;
}

async function main() {
  mustExist("index.js");
  mustExist("pruner.js");
  mustExist(path.join("handlers", "index.js"));

  const handlersMod = await import(pathToFileURL(mustExist(path.join("handlers", "index.js"))).href);
  const prunerMod = await import(pathToFileURL(mustExist("pruner.js")).href);

  const { createBeforeAgentStartHandler, createLlmInputHandler, createLlmOutputHandler } = handlersMod;
  const { sessionModelCache, sessionRealInputTokensCache } = prunerMod;

  const infoLogs = [];
  const logger = {
    info: (m) => infoLogs.push(String(m)),
    warn: (m) => infoLogs.push(`[WARN] ${String(m)}`),
    debug: () => {},
    error: (m) => infoLogs.push(`[ERROR] ${String(m)}`),
  };

  const config = {
    pruning_threshold: 80,
    trigger_every_n_tokens: 10,
    keep_recent_tokens: 0,
    keep_recent_messages: 0,
    soft_threshold: 0,
    hard_threshold: 0,
    detail_threshold: 0,
    detail_pruning_mode: "default",
    detail_placeholder: "[DETAIL_PRUNED]",
    hard_clear_placeholder: "[CLEARED]",
    soft_trim: { max_chars: 40, head_chars: 10, tail_chars: 10 },
    pruning_timeout_ms: 20_000,
    debug_pruning_io: false,
    debug_summary_io: false,
    debug_preview_chars: 120,
  };

  const beforeHandler = createBeforeAgentStartHandler(config, logger);
  const llmInputHandler = createLlmInputHandler(logger);
  const llmOutputHandler = createLlmOutputHandler(config, logger);

  const sessionKey = `verify:quick:${Date.now()}`;

  // Step 1: model cache
  llmInputHandler({ model: "test-model" }, { sessionKey });
  if (sessionModelCache.get(sessionKey) !== "test-model") {
    throw new Error("llm_input did not cache model id");
  }

  // Step 2: real usage cache
  llmOutputHandler({ model: "test-model", usage: { input_tokens: 120 } }, { sessionKey });
  if (sessionRealInputTokensCache.get(sessionKey) !== 120) {
    throw new Error("llm_output did not cache input_tokens");
  }

  // Step 3: should trigger pruning
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "hello" },
    { role: "tool_result", content: [{ type: "text", text: "X".repeat(5000) }] },
  ];
  await beforeHandler({ messages }, { sessionKey });

  // Step 4: below threshold => skip
  llmOutputHandler({ model: "test-model", usage: { input_tokens: 35 } }, { sessionKey });
  await beforeHandler({ messages }, { sessionKey });

  // Step 5: above threshold but within cooldown => skip
  llmOutputHandler({ model: "test-model", usage: { input_tokens: 125 } }, { sessionKey });
  await beforeHandler({ messages }, { sessionKey });

  const hasPrune = infoLogs.some((l) => l.includes("prune#"));
  const hasBelow = infoLogs.some((l) => l.includes("reason=below_threshold"));
  const hasCooldown = infoLogs.some((l) => l.includes("reason=cooldown"));

  console.log("hasPrune:", hasPrune);
  console.log("hasBelowThresholdSkip:", hasBelow);
  console.log("hasCooldownSkip:", hasCooldown);

  if (!hasPrune || !hasBelow || !hasCooldown) {
    console.error("\n--- last logs ---\n" + infoLogs.slice(-30).join("\n"));
    process.exit(1);
  }

  console.log("PASS quick-verify");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
