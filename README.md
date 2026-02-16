# 🚀 OpenClaw Easy Pruning Plugin

<p align="left">
  <img alt="OpenClaw Plugin" src="https://img.shields.io/badge/OpenClaw-Plugin-5B6CFF" />
  <img alt="Version" src="https://img.shields.io/badge/version-0.3.1-00A86B" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-Strict-3178C6" />
  <img alt="Tests" src="https://img.shields.io/badge/tests-13%2F13%20passing-2EA043" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-orange" />
</p>

A context-management **OpenClaw plugin** for rule-based context pruning for all scenarios.

---

## ✨ At a glance

- 🧩 **Native OpenClaw plugin architecture** (no core patching)
- 🛡️ **Safety-first retention** (`system`/`user` + recent tokens/messages)
- ⚙️ **Three-stage policy engine** (`Soft → Hard → Detail`)
- 🔍 **Observable runtime behavior** (clear gateway pruning logs)
- 🔄 **Upgrade-friendly design** (standalone, model-agnostic)

---

## Why this project exists

Large real-world OpenClaw sessions often fail for practical reasons:

- Context windows fill up with old tool output long before the useful conversation is over
- Critical user/system intent gets diluted by noisy historical execution details
- Recovery is painful when context overflows happen in the middle of active work
- Built-in generic pruning modes are not always enough for workflow-specific needs

Easy Pruning was created to solve this gap with a predictable, plugin-first approach:

- **No core patching**: safer upgrades, lower maintenance risk
- **Model-agnostic**: works across providers/models (while official implementation only works for claude)
- **Rule-based and inspectable**: behavior is deterministic and easy to manage
- **Safety-first retention**: preserve user/system + recent context first
- **Operational visibility**: pruning decisions are visible in logs
- **Memory Safety**: on-disk `*.jsonl` history remains unchanged for auditability and traceability

In short: it helps teams keep long sessions usable, reduce context waste, and avoid avoidable model interruptions.

---

## Why users choose **OpenClaw Easy Pruning**

- ✅ Keep long-running OpenClaw sessions usable without manual transcript cleanup
- ✅ Reduce token waste from stale tool/process-heavy content
- ✅ Lower risk of `context_length_exceeded` in real production workflows
- ✅ Preserve critical intent (system/user + recent context) while trimming old noise
- ✅ Stay future-compatible with OpenClaw updates through standalone plugin design
- ✅ Start with deterministic rules now, extend to smarter strategies later

### Best fit scenarios

- Multi-hour debugging, research, or operations sessions
- Tool-heavy conversations with large intermediate outputs
- Teams that need predictable, auditable pruning behavior
- Operators who want context stability without touching OpenClaw core

---

## 📌 Status

- Version: `0.3.1`
- Runtime entry: `dist/index.js`
- Test status: `12/12` passing
- Production profile validated (threshold restored after verification)

---

## Features

- Standalone plugin architecture (no core patch required)
- `before_agent_start` hook integration
- Trigger gating by:
  - `pruning_threshold`
  - `trigger_every_n_tokens`
- Protection rules:
  - all `system` messages
  - all `user` messages
  - recent `keep_recent_tokens`
  - recent `keep_recent_messages`
- Three-stage pruning pipeline:
  - **Soft**: truncate long tool outputs
  - **Hard**: replace old tool outputs with placeholder
  - **Detail**: keep concise user-facing details, drop process-heavy internals
- Supports threshold values as:
  - ratio (`<1`)
  - absolute token position (`>=1`)

### Detail pruning modes (new)

`detail_pruning_mode` supports 3 options:

1. `default` (default)
   - keep existing detail behavior
   - assistant keeps text blocks, process-heavy blocks are dropped
2. `keep_last_reply`
   - keep only the latest assistant reply text in detail zone
   - older process/tool details are replaced
3. `model_summary`
   - generate concise summary for detail-zone messages
   - tries model API first, and falls back to heuristic summary when unavailable

---

## Install (local project path)

```bash
cd /home/node/.openclaw/workspace/projects/easy-pruning-plugin
npm install
npm run build
```

Load path in OpenClaw config:

```json
{
  "plugins": {
    "load": {
      "paths": ["/home/node/.openclaw/workspace/projects/easy-pruning-plugin"]
    }
  }
}
```

Enable plugin entry:

```json
{
  "plugins": {
    "entries": {
      "easy-pruning": {
        "enabled": true,
        "config": {
          "pruning_threshold": 120000,
          "trigger_every_n_tokens": 6000,
          "keep_recent_tokens": 24000,
          "keep_recent_messages": 12,
          "soft_threshold": 0.6,
          "hard_threshold": 0.78,
          "detail_threshold": 0.9,
          "detail_pruning_mode": "default"
        }
      }
    }
  }
}
```

---

## Full Configuration Reference

```json
{
  "pruning_threshold": 80000,
  "trigger_every_n_tokens": 5000,
  "keep_recent_tokens": 10000,
  "keep_recent_messages": 10,
  "keep_rencent_message": 10,
  "soft_threshold": 0.7,
  "hard_threshold": 0.85,
  "detail_threshold": 0.95,
  "detail_pruning_mode": "default",
  "detail_summary_model": "gpt-5.2",
  "detail_summary_max_chars": 600,
  "detail_summary_timeout_ms": 8000,
  "debug_pruning_io": false,
  "debug_summary_io": false,
  "debug_preview_chars": 240,
  "soft_trim": {
    "max_chars": 4000,
    "head_chars": 1500,
    "tail_chars": 1500
  },
  "hard_clear_placeholder": "[Old tool result content cleared]",
  "detail_placeholder": "[Detailed execution context pruned to save tokens]",
  "skip_tools_with_images": true,
  "compaction_threshold_hint": 120000
}
```

### Notes
- `keep_rencent_message` is a backward-compatible typo alias for `keep_recent_messages`.
- `soft_threshold`, `hard_threshold`, `detail_threshold`:
  - `<1` means percentage of current context
  - `>=1` means absolute token position from context start
- `detail_pruning_mode=model_summary`:
  - uses available plugin model APIs when exposed by runtime (`generateText` / `callModel` / `ask`)
  - model selection is from `detail_summary_model` (e.g. `step-3.5`)
  - automatically falls back to heuristic summary if model API is unavailable or times out

### Safety & Tool Call Integrity

The pruning engine preserves **tool call linkage** to avoid `call_id` mismatches:

- If an assistant message contains `toolCall` blocks, their `id` and `name` are **always retained** (only `arguments`/`partialJson` are compressed).
- After detail pruning, the assistant content is reconstructed as `[compact toolCalls] + [summary text]` to maintain structure.
- This ensures subsequent `toolResult` messages can match their `call_id` without errors.

### How model summary is called

When `detail_pruning_mode` is `model_summary`, the plugin builds a summary prompt and calls the first available runtime API in this order:

1. `api.generateText(...)`
2. `api.callModel(...)`
3. `api.ask(...)`

Parameters include:
- `model`: `detail_summary_model` (optional)
- `maxTokens`: 280 (internal cap)
- timeout: `detail_summary_timeout_ms`

If all model calls fail or timeout, it falls back to heuristic summarization.

### Example: use step-3.5 for summary

```json
{
  "plugins": {
    "entries": {
      "easy-pruning": {
        "enabled": true,
        "config": {
          "detail_pruning_mode": "model_summary",
          "detail_summary_model": "step-3.5",
          "detail_summary_max_chars": 600,
          "detail_summary_timeout_ms": 8000
        }
      }
    }
  }
}
```

### Summary output examples (from real mode tests)

- `default`
```text
[{"type":"text","text":"This is the final actionable answer for user."}]
```

- `keep_last_reply`
```text
[{"type":"text","text":"[Last assistant reply kept]\n\nThis is the final actionable answer for user."}]
```

- `model_summary`
```text
[{"type":"text","text":"[Model summary (assistant)]\n\nShort model summary for follow-up context."}]
```

### Debug interface (new in 0.3.1)

Enable runtime debug logs from plugin config:

```json
{
  "debug_pruning_io": true,
  "debug_summary_io": true,
  "debug_preview_chars": 240
}
```

What each switch does:
- `debug_pruning_io`: logs per-message pruning entries (zone, role, before/after tokens, deleted tokens, previews)
- `debug_summary_io`: logs model-summary prompt/output previews and candidate call failures
- `debug_preview_chars`: truncation length for debug previews in logs

---

## Logs (observability)

Typical logs:

```text
[EasyPruning][Gateway] session=<id> context=<tokens>t threshold=<tokens>t triggerEvery=<tokens>t
[EasyPruning][Gateway] prune#<n> session=<id> before=<t> after=<t> deleted=<t> (<pct>%) changed=<n>msg [soft:<n>/-<t> hard:<n>/-<t> detail:<n>/-<t>]
[EasyPruning][Gateway] skip: cooldown session=<id> context=<t> grew=<t> required=<t>
```

Debug logs (when enabled):

```text
[EasyPruning][Debug] summary_api=generateText model=step-3.5 role=assistant prompt=... output=...
[EasyPruning][Debug] session=<id> prune#<n> entries=[{"index":4,"role":"toolResult","zone":"detail","beforeTokens":512,"afterTokens":72,"deletedTokens":440,...}]
```

---

## Measuring token savings

Use pruning logs to quantify savings:

```text
[EasyPruning][Gateway] prune#7 ... before=28178t after=26200t deleted=1978t (7.0%) ...
```

Aggregate multiple events:

- total deleted tokens = sum(`deleted`)
- average reduction = avg(`deleted / before`)
- per-zone impact = sum of `soft/hard/detail` deletion terms in log tail

Tip: keep debug disabled for normal operations; enable it briefly for diagnostics.

---

## Development

```bash
npm install
npm run clean
npm run build
npm test
npm pack --dry-run
```

### Mode testing matrix

The test suite validates all detail modes:

- `default`
- `keep_last_reply`
- `model_summary` (with mocked summary provider)

Run:

```bash
npm test
```

---

## Project Layout

```text
easy-pruning-plugin/
├── src/
│   ├── index.ts
│   ├── pruner.ts
│   └── strategies.ts
├── tests/
│   └── pruner.test.ts
├── dist/
├── openclaw.plugin.json
├── README.md
├── CHANGELOG.md
├── CONTRIBUTING.md
└── RELEASE.md
```

## License
MIT License