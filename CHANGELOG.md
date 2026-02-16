# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0] - 2026-02-16

### Added
- Standalone OpenClaw plugin with `before_agent_start` hook.
- Three-stage strategy pipeline: `soft -> hard -> detail`.
- Ratio and absolute threshold support for stage boundaries.
- Session-scoped trigger gating using:
  - `pruning_threshold`
  - `trigger_every_n_tokens`
- Protection rules for:
  - all `system` messages
  - all `user` messages
  - recent `keep_recent_tokens`
  - recent `keep_recent_messages`
- Compatibility alias for typo key: `keep_rencent_message`.
- Structured pruning statistics (`PruningStats`) and improved logs.

### Fixed
- Plugin id/name mismatch (`easy-pruning`) to avoid load warnings.
- Guard against negative cooldown growth by clamping with `Math.max(0, ...)`.
- Build output path so runtime entry resolves to `dist/index.js`.

### Notes
- Pruning is in-memory only and does not rewrite session `*.jsonl` files.
