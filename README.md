# 🚀 OpenClaw Easy Pruning Plugin

<p align="left">
  <img alt="OpenClaw Plugin" src="https://img.shields.io/badge/OpenClaw-Plugin-5B6CFF" />
  <img alt="Version" src="https://img.shields.io/badge/version-0.2.0-00A86B" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-Strict-3178C6" />
  <img alt="Tests" src="https://img.shields.io/badge/tests-7%2F7%20passing-2EA043" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-orange" />
</p>

A context-management **OpenClaw plugin** for rule-based context pruning.

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
- **Model-agnostic**: works across providers/models
- **Rule-based and inspectable**: behavior is deterministic and easy to reason about
- **Safety-first retention**: preserve user/system + recent context first
- **Operational visibility**: pruning decisions are visible in logs
- **Context Safety**: trims oversized context in memory only before each agent run, while preserving safety-critical context and recent conversation continuity. On-disk `*.jsonl` history remains unchanged for auditability and traceability.

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

- Version: `0.2.0`
- Runtime entry: `dist/index.js`
- Test status: `7/7` passing
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
          "trigger_every_n_tokens": 60000,
          "keep_recent_tokens": 24000,
          "keep_recent_messages": 12,
          "soft_threshold": 0.6,
          "hard_threshold": 0.78,
          "detail_threshold": 0.9
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
- `keep_rencent_message` is a backward-compatible alias (typo support).
- `soft_threshold`, `hard_threshold`, `detail_threshold`:
  - `<1` means percentage of current context
  - `>=1` means absolute token position from context start

---

## Logs (observability)

Typical logs:

```text
[EasyPruning][Gateway] session=<id> context=<tokens>t threshold=<tokens>t triggerEvery=<tokens>t
[EasyPruning][Gateway] prune#<n> session=<id> before=<t> after=<t> deleted=<t> (<pct>%) changed=<n>msg [soft:<n>/-<t> hard:<n>/-<t> detail:<n>/-<t>]
[EasyPruning][Gateway] skip: cooldown session=<id> context=<t> grew=<t> required=<t>
```

---

## Development

```bash
npm install
npm run clean
npm run build
npm test
npm pack --dry-run
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