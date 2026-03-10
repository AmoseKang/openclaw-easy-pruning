#!/usr/bin/env node

/**
 * Easy Pruning - 自动化验证脚本
 *
 * 功能：
 * 1) 检查编译输出是否存在（dist/index.js）
 * 2) 验证 OpenRouter key 读取（env 或 OpenClaw auth-profiles.json）
 * 3) 可选：发起一次真实 OpenRouter 调用（用于验证 model_summary）
 * 4) 可选：检查 openclaw.json 中的 easy-pruning 配置阈值合理性
 *
 * 用法：
 *   npm run build && npm run verify
 *
 * 环境变量：
 *   OPENROUTER_API_KEY       直接提供 OpenRouter key（不会打印）
 *   OPENCLAW_HOME            OpenClaw 数据目录（默认 ~/.openclaw）
 *   OPENCLAW_AGENT_DIR       agentDir（可选，用于定位 auth-profiles.json）
 *   OPENCLAW_CONFIG          openclaw.json 路径（默认 $OPENCLAW_HOME/openclaw.json）
 *   EASY_PRUNING_VERIFY_LIVE 设为 "0" 可跳过真实 API 调用（默认会调用一次）
 */

import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import fs from "node:fs";

const ROOT = process.cwd();
const openclawHome = (process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw")).trim();
const openclawConfigPath = (process.env.OPENCLAW_CONFIG || path.join(openclawHome, "openclaw.json")).trim();

function log(icon, msg) {
  console.log(`${icon} ${msg}`);
}

function fatal(msg) {
  log("❌", msg);
  process.exit(1);
}

function info(msg) {
  log("ℹ️", msg);
}

function success(msg) {
  log("✅", msg);
}

async function checkBuild() {
  const indexPath = path.join(ROOT, "dist", "index.js");
  try {
    await readFile(indexPath, "utf8");
    success("Build exists: dist/index.js");
  } catch {
    fatal("Build missing. Run: npm run build");
  }
}

function resolveAuthStoreCandidates() {
  const out = [];
  const add = (p) => {
    const raw = String(p || "").trim();
    if (!raw) return;
    if (!out.includes(raw)) out.push(raw);
  };

  const agentDir = (process.env.OPENCLAW_AGENT_DIR || process.env.PI_CODING_AGENT_DIR || "").trim();
  if (agentDir) {
    add(path.join(agentDir, "auth-profiles.json"));
    add(path.join(agentDir, "agent", "auth-profiles.json"));
  }

  add(path.join(openclawHome, "auth-profiles.json"));
  add(path.join(openclawHome, "agents", "main", "agent", "auth-profiles.json"));

  // best-effort scan
  try {
    const agentsRoot = path.join(openclawHome, "agents");
    if (fs.existsSync(agentsRoot)) {
      for (const name of fs.readdirSync(agentsRoot)) {
        add(path.join(agentsRoot, name, "agent", "auth-profiles.json"));
      }
    }
  } catch {
    // ignore
  }

  return out;
}

async function readAuthStore() {
  for (const p of resolveAuthStoreCandidates()) {
    try {
      const raw = await readFile(p, "utf8");
      const obj = JSON.parse(raw);
      const profile = obj?.profiles?.["openrouter:default"];
      if (profile?.type === "api_key" && profile?.provider === "openrouter" && profile?.key) {
        success(`Auth store found: ${p}`);
        return { key: String(profile.key).trim(), path: p };
      }
    } catch {
      // ignore
    }
  }
  fatal("OpenRouter auth store not found or invalid (and OPENROUTER_API_KEY not set)");
}

async function verifyOpenRouterApi(key, model = "stepfun/step-3.5-flash:free") {
  // 规范化模型 ID
  let normalized = String(model || "").trim();
  if (normalized.startsWith("openrouter/")) normalized = normalized.slice("openrouter/".length);
  if (normalized === "step" || normalized === "step-3.5") normalized = "stepfun/step-3.5-flash";
  if (normalized === "stepfun/step-3.5-flash:free") normalized = "stepfun/step-3.5-flash";

  info(`Testing model: ${normalized} (from config: ${model})`);

  const payload = {
    model: normalized,
    messages: [{ role: "user", content: "Summarize this in one sentence: Easy Pruning plugin test." }],
    max_tokens: 50,
    temperature: 0.2,
  };

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      "HTTP-Referer": "https://openclaw.ai",
      "X-Title": "EasyPruning-Verify",
    },
    body: JSON.stringify(payload),
  });

  const body = await resp.text();
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    // ignore
  }

  if (!resp.ok) {
    fatal(`OpenRouter API error ${resp.status}: ${body.slice(0, 200)}`);
  }

  // 支持 StepFun 推理模型响应：content 为空，文本在 reasoning 中
  const message = parsed?.choices?.[0]?.message;
  const content = String(message?.content || "").trim() || String(message?.reasoning || "").trim();

  if (!content) {
    fatal("Unexpected response structure: missing message.content and message.reasoning");
  }

  success(`OpenRouter call succeeded. Response: ${content.slice(0, 80)}${content.length > 80 ? "..." : ""}`);
  return { status: resp.status, model: parsed?.model, provider: parsed?.provider };
}

async function checkConfig() {
  try {
    const raw = await readFile(openclawConfigPath, "utf8");
    const config = JSON.parse(raw);
    const pruningCfg = config?.plugins?.entries?.["easy-pruning"]?.config;

    if (!pruningCfg) {
      info("No easy-pruning config found in openclaw.json (will use defaults)");
      return null;
    }

    const checks = [
      { key: "pruning_threshold", expect: (v) => v >= 80000, default: 80000 },
      { key: "keep_recent_tokens", expect: (v) => v <= 30000, default: 20000 },
      { key: "detail_threshold", expect: (v) => v >= 0.7, default: 0.95 },
      { key: "detail_pruning_mode", expect: (v) => v === "model_summary", default: "default" },
      { key: "detail_summary_model", expect: (v) => !String(v || "").startsWith("openrouter/"), default: undefined },
    ];

    const issues = [];
    for (const { key, expect, default: def } of checks) {
      const val = pruningCfg[key];
      if (val === undefined) {
        info(`Config: ${key} not set (default: ${def})`);
      } else if (!expect(val)) {
        issues.push(`  - ${key}: ${JSON.stringify(val)} - 可能影响 detail pruning 触发`);
      } else {
        success(`Config OK: ${key}=${JSON.stringify(val)}`);
      }
    }

    if (issues.length > 0) {
      console.warn("⚠️ Config warnings:");
      issues.forEach((i) => console.warn(i));
      console.warn("建议：keep_recent_tokens 降低到 20000-30000 以保证 detail 区域可用");
    } else {
      success("All config thresholds look good for detail pruning");
    }

    return pruningCfg;
  } catch (e) {
    info(`Cannot read openclaw.json (${openclawConfigPath}): ${String(e?.message || e)}`);
    return null;
  }
}

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Easy Pruning - 自动化验证");
  console.log("═══════════════════════════════════════════════════════\n");

  await checkBuild();

  console.log("\n📦 Checking auth store...");
  const fromEnv = String(process.env.OPENROUTER_API_KEY || "").trim();
  const { key } = fromEnv ? { key: fromEnv } : await readAuthStore();

  const live = String(process.env.EASY_PRUNING_VERIFY_LIVE || "1").trim() !== "0";
  if (live) {
    console.log("\n🌐 Verifying OpenRouter API (live)...");
    await verifyOpenRouterApi(key);
  } else {
    info("Skipping live OpenRouter call (EASY_PRUNING_VERIFY_LIVE=0)");
  }

  console.log("\n⚙️ Checking configuration...");
  await checkConfig();

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("✅ All checks passed");
  console.log("═══════════════════════════════════════════════════════");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
