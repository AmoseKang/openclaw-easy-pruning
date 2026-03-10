#!/usr/bin/env node

/**
 * Live Chat Completions check (OpenRouter).
 *
 * Usage:
 *   node tests/verify-chat-api-live.mjs [model] [prompt]
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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

  const openclawHome = (process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw")).trim();
  add(path.join(openclawHome, "auth-profiles.json"));
  add(path.join(openclawHome, "agents", "main", "agent", "auth-profiles.json"));

  return out;
}

function readOpenRouterKeyFromAuthStore(filePath) {
  try {
    if (!fs.existsSync(filePath)) return "";
    const obj = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const profiles = obj?.profiles || {};
    const preferred = profiles["openrouter:default"];
    if (preferred?.provider === "openrouter" && preferred?.type === "api_key" && preferred?.key) {
      return String(preferred.key).trim();
    }
    for (const v of Object.values(profiles)) {
      if (v?.provider === "openrouter" && v?.type === "api_key" && v?.key) {
        return String(v.key).trim();
      }
    }
  } catch {
    // ignore
  }
  return "";
}

function resolveOpenRouterApiKey() {
  const fromEnv = (process.env.OPENROUTER_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  for (const p of resolveAuthStoreCandidates()) {
    const key = readOpenRouterKeyFromAuthStore(p);
    if (key) return key;
  }
  return "";
}

const key = resolveOpenRouterApiKey();
if (!key) {
  console.log(JSON.stringify({ ok: false, error: "no openrouter key from env/auth-profiles" }));
  process.exit(2);
}

const model = process.argv[2] || "stepfun/step-3.5-flash";
const prompt = process.argv[3] || "Reply with exactly: CHAT_API_OK";

const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${key}`,
  },
  body: JSON.stringify({
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 256,
    temperature: 0,
  }),
});

const raw = await resp.text();
let data = null;
try {
  data = JSON.parse(raw);
} catch {
  const l = raw.indexOf("{");
  const r = raw.lastIndexOf("}");
  if (l >= 0 && r > l) {
    try {
      data = JSON.parse(raw.slice(l, r + 1));
    } catch {}
  }
}

const content = data?.choices?.[0]?.message?.content;
const text =
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((x) => (typeof x?.text === "string" ? x.text : "")).join("\n")
      : "";

const hasText = String(text || "").trim().length > 0;
const ok = resp.ok && !!data?.id && hasText;

console.log(
  JSON.stringify(
    {
      ok,
      status: resp.status,
      model,
      outputPreview: String(text || "").slice(0, 200),
      rawPreview: raw.slice(0, 300),
      expectedHint: "CHAT_API_OK",
      note: ok ? "chat api returned content" : "api ok but empty/invalid content",
    },
    null,
    2,
  ),
);

if (!ok) process.exit(1);
