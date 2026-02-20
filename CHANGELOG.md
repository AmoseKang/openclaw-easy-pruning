# Changelog

All notable changes to this project will be documented in this file.

## [0.3.6] - 2026-02-20

### Changed
- Simplified trigger logic to use only real usage from `llm_output` (`usage.input_tokens` and compatible fields).
- `before_agent_start` now uses cached `real_input_tokens` + `trigger_every_n_tokens` cooldown gate.
- `llm_input` now only records latest model id for observability.

### Removed
- `token_estimate_multiplier` trigger path.
- Dynamic calibration fields and ratio-tracker flow (`dynamic_ratio_calibration`, per-model multiplier overrides, multiplier clamp logic).

### Added
- Clear trigger logs with real-token source and skip reasons (`below_threshold` / `cooldown`).
- Outlier guard for invalid/abnormal usage token samples.

## [0.3.5] - 2026-02-18

### Added
- Dynamic per-model token calibration (方案A): listens to `llm_output.usage.input` and learns a smoothed chars/token ratio per model.
- Dynamic multiplier clamp bounds: `dynamic_multiplier_min` / `dynamic_multiplier_max` (safety guard against extreme calibration).
- Optional per-model overrides: `token_estimate_multiplier_by_model`.
- Extra runtime logs for tracking:
  - `estimated=... multiplier=... src=...` on `before_agent_start`
  - `ratio_update ... multiplier=... clamped=...` on `llm_output` (when `debug_summary_io=true`).

## [0.3.4] - 2026-02-17

### Added
- Whole-pass timeout guard via `pruning_timeout_ms` for pruning pipeline.
- Fallback behavior on timeout: when `detail_pruning_mode=model_summary`, automatically retries with `detail_pruning_mode=default`.
- OpenRouter-only gating for Step/OpenRouter model configs to avoid unnecessary OpenAI fallback attempts.
- Summary latency optimization payload hints:
  - OpenRouter: `include_reasoning: false`, `reasoning.enabled: false` (with compatibility retry)
  - OpenAI Responses: `reasoning.effort: "minimal"`

### Fixed
- Cooldown state lock after reload (`grew=0` loop): reset session trigger state on handler init and rebase baseline when context shrinks.
- Expanded OpenRouter API key discovery paths (env/API object/auth store variants).
- Improved tool-call linkage preservation across runtime block variants:
  - supports `toolCall/tool_call/functionCall/function_call`
  - supports id fields `id/call_id/callId/toolCallId/function_call_id`
- Strengthened safety invariant checks to avoid pruning when tool-call identifiers would be lost.

### Verified
- Test suite: `17/17` passing
- Build: TypeScript compile success
- Packaging: `npm pack --dry-run` clean output

## [0.3.2] - 2026-02-16

### Fixed
- **Critical toolCall preservation bug**: Detail pruning modes previously removed entire assistant messages containing `toolCall` blocks, breaking `toolResult` linkage by `call_id`.
  - New `hasToolCallBlocks`, `compactToolCallBlock`, `buildAssistantContentWithToolCalls` keep `id`/`name` skeleton and compress `arguments`/`partialJson`.
  - All detail modes (`default`, `keep_last_reply`, `model_summary`) now apply toolCall preservation.
  - Unit tests extended (13/13) to verify toolCall retention across detail modes.

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
