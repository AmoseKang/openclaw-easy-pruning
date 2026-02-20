# 🚀 OpenClaw Easy Pruning Plugin

<p align="left">
  <img alt="OpenClaw Plugin" src="https://img.shields.io/badge/OpenClaw-Plugin-5B6CFF" />
  <img alt="Version" src="https://img.shields.io/badge/version-0.3.6-00A86B" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-Strict-3178C6" />
  <img alt="Tests" src="https://img.shields.io/badge/tests-20%2F20%20passing-2EA043" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-orange" />
</p>

Rule-based context pruning for OpenClaw sessions.

## What changed in v0.3.6

This version **simplifies token tracking** and now relies on new runtime hooks:

- `llm_input`: records latest model id per session
- `llm_output`: records real `usage input tokens` per session
- `before_agent_start`: decides whether to prune based on real usage cache

Removed from trigger logic:

- token estimate multiplier
- dynamic ratio calibration
- per-model multiplier overrides

So trigger control is now minimal and explicit:

- `pruning_threshold`
- `trigger_every_n_tokens`

## Trigger logic (simplified)

Before each run:

1. Read last `real_input_tokens` from `llm_output`
2. If `< pruning_threshold`, skip
3. If growth since last trigger `< trigger_every_n_tokens`, skip
4. Otherwise run pruning pipeline (`soft -> hard -> detail`)

This gives stable behavior with fewer knobs.

## Install

```bash
cd /home/node/.openclaw/workspace/projects/easy-pruning-plugin
npm install
npm run build
```

## OpenClaw config example

```json
{
  "plugins": {
    "load": {
      "paths": ["/home/node/.openclaw/workspace/projects/easy-pruning-plugin"]
    },
    "entries": {
      "easy-pruning": {
        "enabled": true,
        "config": {
          "pruning_threshold": 80000,
          "trigger_every_n_tokens": 6000,

          "keep_recent_tokens": 20000,
          "keep_recent_messages": 12,

          "soft_threshold": 0.7,
          "hard_threshold": 0.85,
          "detail_threshold": 0.95,

          "detail_pruning_mode": "model_summary",
          "detail_summary_model": "openrouter/stepfun/step-3.5-flash:free",
          "detail_summary_max_chars": 600,
          "detail_summary_timeout_ms": 12000,
          "pruning_timeout_ms": 20000,

          "debug_pruning_io": false,
          "debug_summary_io": false,
          "debug_log_file": "/home/node/.openclaw/logs/easy-pruning.log"
        }
      }
    }
  }
}
```

## Recommended minimal config (trigger only)

```json
{
  "pruning_threshold": 80000,
  "trigger_every_n_tokens": 6000
}
```

Then keep your existing `keep_recent_*` and threshold strategy params unchanged.

## Observability

Typical logs:

```text
[EasyPruning][Gateway] usage_update session=... model=... real_input_tokens=... source=usage.input_tokens
[EasyPruning][Gateway] session=... real_input_tokens=... threshold=... since_last_trigger=... triggerEvery=...
[EasyPruning][Gateway] skip: reason=below_threshold ...
[EasyPruning][Gateway] skip: reason=cooldown ...
[EasyPruning][Gateway] prune#... before=... after=... deleted=... changed=...
```

## Development

```bash
npm run clean
npm run build
npm test
npm pack --dry-run
```

## License

MIT
