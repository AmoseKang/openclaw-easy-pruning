# Changelog

All notable changes to this project will be documented in this file.

## [0.3.1] - 2026-02-16

### Added
- Debug interface config:
  - `debug_pruning_io`
  - `debug_summary_io`
  - `debug_preview_chars`
- Per-message debug pruning entries in runtime logs (zone, before/after tokens, preview).
- Model-summary debug logs with API candidate name, prompt preview, and output preview.

### Changed
- README refreshed with debug usage and token-savings measurement guidance.
- Test suite expanded to `12/12`.

## [0.3.0] - 2026-02-16

### Added
- Configurable detail pruning modes via `detail_pruning_mode`:
  - `default`
  - `keep_last_reply`
  - `model_summary`
- Optional model-summary config options:
  - `detail_summary_model`
  - `detail_summary_max_chars`
  - `detail_summary_timeout_ms`
- Best-effort model summary provider wiring in plugin register.
- Heuristic fallback summary when model API is unavailable or times out.
- Tests for all detail pruning modes.

### Changed
- Core pruning pipeline is now async to support model-backed detail summarization.
- Renamed detail mode `current` -> `default` (no legacy compatibility retained).
- Plugin/manifest version bumped to `0.3.0`.

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
