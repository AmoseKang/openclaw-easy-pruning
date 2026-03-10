#!/usr/bin/env node

/**
 * Easy Pruning - log monitor
 *
 * - Watches the Easy Pruning log file and prints the latest prune stats
 * - Highlights whether detail pruning has been triggered
 *
 * Usage:
 *   npm run monitor
 *
 * Env overrides:
 *   EASY_PRUNING_LOG=/path/to/easy-pruning.log
 *   OPENCLAW_HOME=/path/to/.openclaw
 *   OPENCLAW_LOG_DIR=/path/to/.openclaw/logs
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const openclawHome = (process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw")).trim();
const logDir = (process.env.OPENCLAW_LOG_DIR || path.join(openclawHome, "logs")).trim();
const LOG_PATH = (process.env.EASY_PRUNING_LOG || path.join(logDir, "easy-pruning.log")).trim();

const POLL_INTERVAL_MS = 10_000;

let lastPos = 0;

function formatSize(tokens) {
  return `${Number(tokens).toLocaleString()}t`;
}

function parseLine(line) {
  // Example:
  // [EasyPruning][Gateway] prune#1 ... before=98905t after=86156t deleted=12749t (12.9%) changed=3msg [soft:3/-12749t hard:0/-0t detail:0/-0t]
  const pruneMatch = line.match(
    /prune#(\d+).*before=(\d+)t after=(\d+)t deleted=(\d+)t \((\d+\.?\d*)%\) changed=(\d+)msg/,
  );
  const regionMatch = line.match(/\[soft:(\d+)\/(-?\d+)t hard:(\d+)\/(-?\d+)t detail:(\d+)\/(-?\d+)t\]/);

  const out = {};
  if (pruneMatch) {
    out.prune = {
      seq: Number(pruneMatch[1]),
      before: Number(pruneMatch[2]),
      after: Number(pruneMatch[3]),
      deleted: Number(pruneMatch[4]),
      pct: Number(pruneMatch[5]),
      changed: Number(pruneMatch[6]),
    };
  }
  if (regionMatch) {
    out.regions = {
      soft: { count: Number(regionMatch[1]), tokens: Number(regionMatch[2]) },
      hard: { count: Number(regionMatch[3]), tokens: Number(regionMatch[4]) },
      detail: { count: Number(regionMatch[5]), tokens: Number(regionMatch[6]) },
    };
  }

  return Object.keys(out).length > 0 ? out : null;
}

async function readFromOffset(filePath, offset) {
  const fh = await fs.promises.open(filePath, "r");
  try {
    const stat = await fh.stat();
    const size = stat.size;
    if (size <= offset) return { text: "", size };

    const len = size - offset;
    const buf = Buffer.allocUnsafe(len);
    await fh.read(buf, 0, len, offset);
    return { text: buf.toString("utf8"), size };
  } finally {
    await fh.close();
  }
}

async function pollOnce(state) {
  if (!fs.existsSync(LOG_PATH)) {
    console.warn(`⚠️  Log file not found: ${LOG_PATH}`);
    return state;
  }

  const stat = await fs.promises.stat(LOG_PATH);
  if (stat.size < lastPos) {
    // log rotated
    lastPos = 0;
  }

  const { text, size } = await readFromOffset(LOG_PATH, lastPos);
  lastPos = size;

  if (!text.trim()) return state;

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    if (parsed.prune) state.latestPrune = parsed.prune;
    if (parsed.regions) state.latestRegions = parsed.regions;
  }

  return state;
}

function printState(state) {
  const p = state.latestPrune;
  if (!p) return;

  console.log("\n" + "─".repeat(72));
  console.log(`📊 Prune Event #${p.seq} @ ${new Date().toISOString()}`);
  console.log(
    `   Total: ${formatSize(p.before)} → ${formatSize(p.after)} | Deleted: ${formatSize(p.deleted)} (${p.pct}%) | Changed msgs: ${p.changed}`,
  );

  const r = state.latestRegions;
  if (r) {
    console.log("   Mode breakdown:");
    console.log(`     • Soft:   ${r.soft.count} runs / ${formatSize(-r.soft.tokens)}`);
    console.log(`     • Hard:   ${r.hard.count} runs / ${formatSize(-r.hard.tokens)}`);
    console.log(`     • Detail: ${r.detail.count} runs / ${formatSize(-r.detail.tokens)}`);

    if (r.detail.count > 0) {
      console.log("   ✅ Detail pruning triggered");
    } else {
      console.log("   ⚠️  Detail pruning NOT triggered yet");
      console.log("   💡 Check: keep_recent_tokens (20k–30k), pruning_threshold (>80k)");
    }
  }

  console.log("─".repeat(72));
}

async function main() {
  console.log("🔍 Easy Pruning Monitor");
  console.log(`   Watching: ${LOG_PATH}`);
  console.log(`   Refresh: every ${POLL_INTERVAL_MS / 1000}s`);
  console.log("   Press Ctrl+C to exit\n");

  const state = { latestPrune: null, latestRegions: null };

  // Initial read
  await pollOnce(state);
  if (!state.latestPrune) {
    console.log("📭 No prune events found in log yet.");
  } else {
    printState(state);
  }

  setInterval(async () => {
    const beforeSeq = state.latestPrune?.seq;
    await pollOnce(state);
    const afterSeq = state.latestPrune?.seq;
    if (afterSeq && afterSeq !== beforeSeq) {
      printState(state);
    }
  }, POLL_INTERVAL_MS);
}

main().catch((e) => {
  console.error("\n❌ Monitor error:", e);
  process.exit(1);
});
