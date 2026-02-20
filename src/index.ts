import fs from 'fs';
import path from 'path';
import type {
  EasyPruningConfig,
  Logger,
  SummaryProvider,
} from "./pruner.js";
import { normalizeConfig } from "./pruner.js";
import {
  createBeforeAgentStartHandler,
  createLlmInputHandler,
  createLlmOutputHandler,
} from "./handlers/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const defaultConfig: EasyPruningConfig = {
  pruning_threshold: 80_000,
  trigger_every_n_tokens: 60_000,
  keep_recent_tokens: 20_000,
  keep_recent_messages: 12,
  soft_threshold: 0.7,
  hard_threshold: 0.85,
  detail_threshold: 0.95,
  soft_trim: {
    max_chars: 4_000,
    head_chars: 1_500,
    tail_chars: 1_500,
  },
  hard_clear_placeholder: "[Old tool result content cleared]",
  detail_placeholder: "[Detailed execution context pruned to save tokens]",
  skip_tools_with_images: true,
  detail_pruning_mode: "default",
  detail_summary_model: undefined,
  detail_summary_max_chars: 600,
  detail_summary_timeout_ms: 20_000,
  pruning_timeout_ms: 20_000,
  detail_batch_enabled: true,
  detail_batch_max_items: 8,
  detail_batch_flush_ms: 15,
  detail_batch_concurrency: 3,
  detail_max_model_items_per_prune: 24,
  debug_pruning_io: false,
  debug_summary_io: false,
  debug_log_file: undefined,
  debug_preview_chars: 240,
};

export default {
  id: "easy-pruning",
  name: "OpenClaw Easy Pruning",
  version: "0.3.6",

  register(api: AnyApi) {
    const rawConfig =
      (api.pluginConfig as Partial<EasyPruningConfig> | undefined) ??
      (api.config?.plugins?.entries?.["easy-pruning"]?.config as Partial<EasyPruningConfig> | undefined) ??
      {};

    const config = normalizeConfig(defaultConfig, rawConfig);

    // Setup optional debug file stream
    const debugLogFile = config.debug_log_file;
    let fileStream: fs.WriteStream | null = null;
    if (typeof debugLogFile === "string" && debugLogFile.trim().length > 0) {
      try {
        // Ensure directory exists (best-effort)
        const dir = debugLogFile.replace(/\/[^/]*$/, '');
        if (dir) fs.mkdirSync(dir, { recursive: true });
        fileStream = fs.createWriteStream(debugLogFile, { flags: 'a' });
      } catch (err) {
        console.error(`[EasyPruning] Failed to open debug log file ${debugLogFile}:`, err);
      }
    }

    const baseLogger = api.logger;
    const fileLogger = {
      info: (msg: string) => {
        baseLogger.info?.(msg);
        fileStream?.write(`[${new Date().toISOString()}] [INFO] ${msg}\n`);
      },
      warn: (msg: string) => {
        baseLogger.warn?.(msg);
        fileStream?.write(`[${new Date().toISOString()}] [WARN] ${msg}\n`);
      },
      debug: (msg: string) => {
        baseLogger.debug?.(msg);
        fileStream?.write(`[${new Date().toISOString()}] [DEBUG] ${msg}\n`);
      },
      error: (msg: string) => {
        baseLogger.error?.(msg);
        fileStream?.write(`[${new Date().toISOString()}] [ERROR] ${msg}\n`);
      },
    };

    // Best-effort warning: if user provides a compaction hint, pruning should happen earlier.
    if (
      typeof config.compaction_threshold_hint === "number" &&
      Number.isFinite(config.compaction_threshold_hint) &&
      config.compaction_threshold_hint > 0 &&
      config.pruning_threshold >= config.compaction_threshold_hint
    ) {
      fileLogger.warn(
        `[EasyPruning] pruning_threshold (${config.pruning_threshold}) should be lower than compaction_threshold_hint (${config.compaction_threshold_hint})`,
      );
    }

    const summaryProvider = createSummaryProvider(api, config, fileLogger);

    // Register pruning handlers
    const beforeHandler = createBeforeAgentStartHandler(config, fileLogger, {
      summaryProvider,
    });
    api.on("before_agent_start", beforeHandler);
    api.on("llm_input", createLlmInputHandler(fileLogger));
    api.on("llm_output", createLlmOutputHandler(config, fileLogger));

    fileLogger.info(
      `[EasyPruning] plugin registered (trigger=${config.pruning_threshold}t, trigger_every=${config.trigger_every_n_tokens}t, detail_pruning_mode=${config.detail_pruning_mode}${
        summaryProvider ? ", model_summary_provider=on" : ""
      }${
        config.debug_pruning_io || config.debug_summary_io
          ? `, debug_pruning_io=${config.debug_pruning_io}, debug_summary_io=${config.debug_summary_io}`
          : ""
      })`,
    );
  },
} as const;

function createSummaryProvider(
  api: AnyApi,
  config: EasyPruningConfig,
  logger: Logger,
): SummaryProvider | undefined {
  if (config.detail_pruning_mode !== "model_summary") {
    return undefined;
  }

  type Candidate = { name: string; call: (prompt: string) => Promise<unknown> };

  const probeCandidates = (): Candidate[] => {
    const candidates: Candidate[] = [];

    if (typeof api.generateText === "function") {
      candidates.push({
        name: "generateText",
        call: async (prompt) =>
          api.generateText({
            prompt,
            model: config.detail_summary_model,
            maxTokens: 280,
          }),
      });
    }

    if (typeof api.callModel === "function") {
      candidates.push({
        name: "callModel",
        call: async (prompt) =>
          api.callModel({
            prompt,
            model: config.detail_summary_model,
            maxTokens: 280,
          }),
      });
    }

    if (typeof api.ask === "function") {
      candidates.push({
        name: "ask",
        call: async (prompt) => api.ask(prompt, { model: config.detail_summary_model }),
      });
    }

    // Compatibility: some runtimes expose model APIs under nested namespaces.
    if (typeof api.models?.generateText === "function") {
      candidates.push({
        name: "models.generateText",
        call: async (prompt) =>
          api.models.generateText({
            prompt,
            model: config.detail_summary_model,
            maxTokens: 280,
          }),
      });
    }

    if (typeof api.llm?.generateText === "function") {
      candidates.push({
        name: "llm.generateText",
        call: async (prompt) =>
          api.llm.generateText({
            prompt,
            model: config.detail_summary_model,
            maxTokens: 280,
          }),
      });
    }

    if (typeof api.llm?.ask === "function") {
      candidates.push({
        name: "llm.ask",
        call: async (prompt) => api.llm.ask(prompt, { model: config.detail_summary_model }),
      });
    }

    // Provider fallback 1: direct OpenRouter chat-completions via OPENROUTER_API_KEY.
    // Reuses OpenClaw environment key when plugin runtime does not expose model APIs.
    const openrouterKey = resolveOpenRouterApiKey(api);
    if (!openrouterKey && config.debug_summary_io) {
      const authCandidates = resolveAuthStoreCandidates(api);
      const probe = authCandidates
        .map((p) => `${p}:${fs.existsSync(p) ? "exists" : "missing"}`)
        .join(",");
      logger.info?.(`[EasyPruning][Debug] openrouter key not found; auth candidates=${probe}`);
    }
    if (openrouterKey) {
      candidates.push({
        name: "openrouter.chat",
        call: async (prompt) => {
          const primaryModel = resolveOpenRouterSummaryModel(config.detail_summary_model);

          const callOnce = async (model: string) => {
            const payloads: Record<string, unknown>[] = [
              {
                model,
                messages: [{ role: "user", content: prompt }],
                max_tokens: 280,
                temperature: 0.2,
                // Best-effort: disable reasoning/thinking to reduce latency.
                include_reasoning: false,
                reasoning: { enabled: false },
              },
              {
                model,
                messages: [{ role: "user", content: prompt }],
                max_tokens: 280,
                temperature: 0.2,
              },
            ];

            let last: { ok: boolean; status: number; body: string; parsed: unknown } | null = null;
            for (const payload of payloads) {
              const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  authorization: `Bearer ${openrouterKey}`,
                },
                body: JSON.stringify(payload),
              });

              const body = await resp.text().catch(() => "");
              let parsed: unknown = null;
              if (body) {
                try {
                  parsed = JSON.parse(body);
                } catch {
                  parsed = null;
                }
              }

              last = { ok: resp.ok, status: resp.status, body, parsed };
              if (resp.ok) {
                return last;
              }

              // If provider rejects reasoning flags, retry once with plain payload.
              if (
                resp.status === 400 &&
                /unknown|invalid|include_reasoning|reasoning/i.test(body)
              ) {
                continue;
              }

              return last;
            }

            return last ?? { ok: false, status: 500, body: "unknown openrouter error", parsed: null };
          };

          const first = await callOnce(primaryModel);
          if (first.ok) {
            if (first.parsed) {
              return first.parsed;
            }
            // Some test/mocked fetch implementations expose json() but empty text().
            const direct = await fetch("https://openrouter.ai/api/v1/chat/completions", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${openrouterKey}`,
              },
              body: JSON.stringify({
                model: primaryModel,
                messages: [{ role: "user", content: prompt }],
                max_tokens: 280,
                temperature: 0.2,
                include_reasoning: false,
                reasoning: { enabled: false },
              }),
            });
            if (!direct.ok) {
              const db = await direct.text().catch(() => "");
              throw new Error(`openrouter.chat http ${direct.status}: ${db.slice(0, 300)}`);
            }
            return await direct.json();
          }

          // Do NOT auto-fallback to a paid model on invalid model id.
          // Safer behavior: fail fast and let caller use heuristic summary.
          throw new Error(`openrouter.chat http ${first.status}: ${first.body.slice(0, 300)}`);
        },
      });
    }

    // Provider fallback 2: direct OpenAI Responses API via OPENAI_API_KEY.
    // If user explicitly targets OpenRouter/Step and OpenRouter key is present,
    // hard-disable OpenAI fallback to avoid quota noise and extra latency.
    const openRouterOnly = shouldForceOpenRouterOnly(config.detail_summary_model, Boolean(openrouterKey));
    const shouldTryOpenAi = !openRouterOnly && shouldProbeOpenAi(config.detail_summary_model, Boolean(openrouterKey));
    if (openRouterOnly && config.debug_summary_io) {
      logger.info?.(
        `[EasyPruning][Debug] openrouter-only summary mode enabled for model=${config.detail_summary_model ?? "(default)"}`,
      );
    }
    if (
      shouldTryOpenAi &&
      typeof process.env.OPENAI_API_KEY === "string" &&
      process.env.OPENAI_API_KEY.length > 0
    ) {
      candidates.push({
        name: "openai.responses",
        call: async (prompt) => {
          const model = resolveOpenAiSummaryModel(config.detail_summary_model);
          const resp = await fetch("https://api.openai.com/v1/responses", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
              model,
              input: prompt,
              max_output_tokens: 280,
              // Best-effort: reduce reasoning budget for faster summaries.
              reasoning: { effort: "minimal" },
            }),
          });

          if (!resp.ok) {
            const body = await resp.text().catch(() => "");
            throw new Error(`openai.responses http ${resp.status}: ${body.slice(0, 300)}`);
          }
          return await resp.json();
        },
      });
    }

    return candidates;
  };

  // Lazy probe: allow runtime APIs to appear after plugin register.
  let cachedCandidates: Candidate[] = [];
  let lastProbeMs = 0;
  let warnedNoApi = false;
  let loggedApiReady = false;
  const probeIntervalMs = 15_000;

  const resolveCandidates = (): Candidate[] => {
    const now = Date.now();
    if (cachedCandidates.length > 0 && now - lastProbeMs < probeIntervalMs) {
      return cachedCandidates;
    }

    const found = probeCandidates();
    lastProbeMs = now;
    cachedCandidates = found;

    if (found.length === 0) {
      if (!warnedNoApi) {
        warnedNoApi = true;
        logger.warn?.(
          "[EasyPruning] detail_pruning_mode=model_summary configured but no model API found yet; fallback to heuristic summary",
        );
        if (config.debug_summary_io) {
          const topLevelKeys = Object.keys(api ?? {}).slice(0, 80).join(",");
          logger.info?.(`[EasyPruning][Debug] summary probe: available api keys=${topLevelKeys}`);
        }
      }
    } else if (!loggedApiReady) {
      loggedApiReady = true;
      logger.info?.(
        `[EasyPruning] model summary API became available: ${found.map((c) => c.name).join(",")}`,
      );
    }

    return found;
  };

  const summarizeSingle = async (input: string, options: { role: string; maxChars: number }) => {
    const candidates = resolveCandidates();
    if (candidates.length === 0) {
      return null;
    }

    const prompt = [
      "Summarize the following OpenClaw context block for future turns.",
      "Keep only key user-facing outcomes, errors, and decisions.",
      `Output plain text within ${options.maxChars} characters.`,
      `Role: ${options.role}`,
      "---",
      input,
    ].join("\n");

    for (const candidate of candidates) {
      try {
        const response = await withTimeout(candidate.call(prompt), config.detail_summary_timeout_ms);
        const text = extractText(response);
        if (text && text.trim()) {
          const summary = text.trim().slice(0, options.maxChars);
          if (config.debug_summary_io) {
            logger.info?.(
              `[EasyPruning][Debug] summary_api=${candidate.name} model=${config.detail_summary_model ?? "(default)"} role=${options.role} prompt=${previewText(prompt, config.debug_preview_chars)} output=${previewText(summary, config.debug_preview_chars)}`,
            );
          }
          return summary;
        }
      } catch (error) {
        if (config.debug_summary_io) {
          logger.warn?.(
            `[EasyPruning][Debug] summary_api=${candidate.name} failed: ${String(error)}`,
          );
        }
      }
    }

    return null;
  };

  type PendingItem = {
    input: string;
    options: { role: string; maxChars: number };
    resolve: (value: string | null) => void;
    reject: (reason?: unknown) => void;
  };

  const pending: PendingItem[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let inFlightBatches = 0;

  const flushPending = async () => {
    if (!config.detail_batch_enabled) return;
    const candidates = resolveCandidates();
    const batchCandidate = candidates.find((c) => c.name === "openrouter.chat");
    if (!batchCandidate) return;

    while (pending.length > 0 && inFlightBatches < config.detail_batch_concurrency) {
      const slice = pending.splice(0, config.detail_batch_max_items);
      inFlightBatches += 1;

      void (async () => {
        try {
          const items = slice.map((x, i) => ({ id: `m${i + 1}`, role: x.options.role, text: x.input }));
          const prompt = [
            "You are summarizing multiple OpenClaw context blocks.",
            `Return JSON only. Max ${Math.max(...slice.map((s) => s.options.maxChars), 600)} chars per summary.`,
            'Format: {"summaries":[{"id":"m1","summary":"..."}]}',
            "If an item has no meaningful output, return a concise neutral summary.",
            "ITEMS:",
            JSON.stringify(items),
          ].join("\n");

          const response = await withTimeout(batchCandidate.call(prompt), config.detail_summary_timeout_ms);
          const text = extractText(response) || "";
          const parsed = parseBatchSummaries(text);

          for (let i = 0; i < slice.length; i++) {
            const id = `m${i + 1}`;
            const candidateSummary = parsed.get(id);
            if (candidateSummary && candidateSummary.trim()) {
              slice[i].resolve(candidateSummary.trim().slice(0, slice[i].options.maxChars));
            } else {
              const single = await summarizeSingle(slice[i].input, slice[i].options);
              slice[i].resolve(single);
            }
          }
        } catch (error) {
          for (const req of slice) {
            try {
              const single = await summarizeSingle(req.input, req.options);
              req.resolve(single);
            } catch (e) {
              req.reject(e);
            }
          }
        } finally {
          inFlightBatches -= 1;
          if (pending.length > 0) {
            void flushPending();
          }
        }
      })();
    }
  };

  return async (input, options) => {
    if (!config.detail_batch_enabled) {
      return summarizeSingle(input, options);
    }

    const candidates = resolveCandidates();
    const hasBatchCapable = candidates.some((c) => c.name === "openrouter.chat");
    if (!hasBatchCapable) {
      return summarizeSingle(input, options);
    }

    return await new Promise<string | null>((resolve, reject) => {
      pending.push({ input, options, resolve, reject });
      if (flushTimer) {
        return;
      }
      flushTimer = setTimeout(() => {
        flushTimer = null;
        void flushPending();
      }, config.detail_batch_flush_ms);
    });
  };
}

function parseBatchSummaries(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  const text = raw.trim();
  if (!text) return out;

  const candidates: string[] = [text];
  const match = text.match(/\{[\s\S]*\}/);
  if (match && match[0] !== text) {
    candidates.push(match[0]);
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { summaries?: Array<{ id?: string; summary?: string }> };
      if (!Array.isArray(parsed.summaries)) continue;
      for (const item of parsed.summaries) {
        const id = String(item?.id || "").trim();
        const summary = String(item?.summary || "").trim();
        if (id && summary) out.set(id, summary);
      }
      if (out.size > 0) return out;
    } catch {
      // ignore parse error and continue
    }
  }

  return out;
}

function resolveOpenRouterSummaryModel(configModel?: string): string {
  const rawInput = (configModel || "").trim();
  // Default to a free model to avoid accidental credit usage.
  if (!rawInput) return "stepfun/step-3.5-flash:free";

  let raw = rawInput;

  // Normalize OpenClaw-style provider prefix for direct OpenRouter endpoint.
  if (raw.startsWith("openrouter/")) {
    raw = raw.slice("openrouter/".length);
  }

  // Alias passthrough for common local alias.
  if (raw === "step" || raw === "step-3.5") return "stepfun/step-3.5-flash:free";

  // Keep explicit provider/model ids as-is, including :free suffix when present.
  if (raw.includes("/")) return raw;

  // Non-qualified aliases fallback to a free model on OpenRouter.
  return "stepfun/step-3.5-flash:free";
}

function resolveOpenRouterApiKey(api?: AnyApi): string | null {
  const fromEnv = (process.env.OPENROUTER_API_KEY || "").trim();
  if (fromEnv) return fromEnv;

  const fromApi = extractOpenRouterKeyFromObject(api);
  if (fromApi) return fromApi;

  const candidates = resolveAuthStoreCandidates(api);
  for (const p of candidates) {
    const key = readOpenRouterKeyFromAuthStore(p);
    if (key) return key;
  }
  return null;
}

function resolveAuthStoreCandidates(api?: AnyApi): string[] {
  const out: string[] = [];
  const add = (p?: string) => {
    const raw = (p || "").trim();
    if (!raw) return;
    if (!out.includes(raw)) out.push(raw);
  };

  const agentDir = (process.env.OPENCLAW_AGENT_DIR || process.env.PI_CODING_AGENT_DIR || "").trim();
  if (agentDir) {
    add(path.join(agentDir, "auth-profiles.json"));
    // Some runtimes point directly to ".../agent".
    add(path.join(agentDir, "agent", "auth-profiles.json"));
  }

  const runtimeAgentDir = String(api?.runtime?.agentDir || "").trim();
  if (runtimeAgentDir) {
    add(path.join(runtimeAgentDir, "auth-profiles.json"));
    add(path.join(runtimeAgentDir, "agent", "auth-profiles.json"));
  }

  // Common fallbacks.
  add("/home/node/.openclaw/auth-profiles.json");
  add("/home/node/.openclaw/agents/main/agent/auth-profiles.json");

  // Scan known agent folders for robustness across runtime contexts.
  try {
    const agentsRoot = "/home/node/.openclaw/agents";
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

function extractOpenRouterKeyFromObject(input: unknown): string | null {
  const seen = new Set<unknown>();
  const queue: unknown[] = [input];
  let steps = 0;

  while (queue.length > 0 && steps < 2000) {
    steps += 1;
    const current = queue.shift();
    if (!current || typeof current !== "object") {
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);

    const obj = current as Record<string, unknown>;

    // Fast path: auth profile object shape.
    const profiles = obj.profiles;
    if (profiles && typeof profiles === "object") {
      const fromProfiles = readOpenRouterKeyFromProfiles(profiles as Record<string, unknown>);
      if (fromProfiles) {
        return fromProfiles;
      }
    }

    // Generic provider-shaped object.
    const provider = String(obj.provider || "").trim();
    const type = String(obj.type || "").trim();
    const key = String(obj.key || "").trim();
    if (provider === "openrouter" && type === "api_key" && key) {
      return key;
    }

    for (const value of Object.values(obj)) {
      if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }

  return null;
}

function readOpenRouterKeyFromProfiles(profiles: Record<string, unknown>): string | null {
  const preferred = profiles["openrouter:default"] as Record<string, unknown> | undefined;
  const preferredKey =
    preferred &&
    String(preferred.provider || "") === "openrouter" &&
    String(preferred.type || "") === "api_key"
      ? String(preferred.key || "").trim()
      : "";
  if (preferredKey) return preferredKey;

  for (const entry of Object.values(profiles)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const v = entry as Record<string, unknown>;
    const provider = String(v.provider || "").trim();
    const type = String(v.type || "").trim();
    const key = String(v.key || "").trim();
    if (provider === "openrouter" && type === "api_key" && key) {
      return key;
    }
  }

  return null;
}

function readOpenRouterKeyFromAuthStore(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    const obj = JSON.parse(raw) as { profiles?: Record<string, unknown> };
    const profiles = obj?.profiles;
    if (!profiles || typeof profiles !== "object") return null;

    return readOpenRouterKeyFromProfiles(profiles as Record<string, unknown>);
  } catch {
    return null;
  }
}

function shouldForceOpenRouterOnly(configModel: string | undefined, hasOpenRouterKey: boolean): boolean {
  if (!hasOpenRouterKey) {
    return false;
  }

  const raw = (configModel || "").trim().toLowerCase();
  if (!raw) {
    return false;
  }

  return (
    raw.startsWith("openrouter/") ||
    raw.startsWith("step") ||
    raw.includes("stepfun/") ||
    raw.includes(":free")
  );
}

function shouldProbeOpenAi(configModel: string | undefined, hasOpenRouterKey: boolean): boolean {
  const raw = (configModel || "").trim().toLowerCase();
  if (!raw) {
    return !hasOpenRouterKey;
  }

  if (
    raw.startsWith("openrouter/") ||
    raw.startsWith("step") ||
    raw.includes("stepfun/") ||
    raw.includes(":free")
  ) {
    return !hasOpenRouterKey;
  }

  if (raw.startsWith("gpt-") || raw.startsWith("openai/") || raw.startsWith("openai-codex/")) {
    return true;
  }

  return !hasOpenRouterKey;
}

function resolveOpenAiSummaryModel(configModel?: string): string {
  const raw = (configModel || "").trim();
  if (!raw) return "gpt-4.1-mini";

  // Accept direct OpenAI model ids and simple aliases.
  if (raw.startsWith("gpt-")) return raw;
  if (raw === "gpt") return "gpt-4.1-mini";

  // OpenClaw aliases/provider-prefixed ids.
  if (raw === "openai-codex/gpt-5.3-codex" || raw === "openai-codex/gpt-5.2" || raw === "openai-codex/gpt-5.2-codex") {
    return "gpt-4.1-mini";
  }

  // Non-OpenAI ids (e.g., openrouter/*) fallback to a safe OpenAI model.
  return "gpt-4.1-mini";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractText(value: any): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  if (typeof value.text === "string") {
    return value.text;
  }

  if (typeof value.output_text === "string") {
    return value.output_text;
  }

  const fromBlocks = extractTextFromBlocks(value.content);
  if (fromBlocks) {
    return fromBlocks;
  }

  // OpenAI/compatible chat shape
  const choiceMessageContent = value?.choices?.[0]?.message?.content;
  if (typeof choiceMessageContent === "string") {
    return choiceMessageContent;
  }
  if (Array.isArray(choiceMessageContent)) {
    const parts = choiceMessageContent
      .map((b: any) => (typeof b?.text === "string" ? b.text : ""))
      .filter(Boolean);
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }

  // OpenAI Responses API shape: output[].content[].text
  if (Array.isArray(value.output)) {
    const parts: string[] = [];
    for (const item of value.output) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const textFromItem = extractTextFromBlocks((item as Record<string, unknown>).content);
      if (textFromItem) {
        parts.push(textFromItem);
      }
    }
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }

  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractTextFromBlocks(blocks: any): string | null {
  if (!Array.isArray(blocks)) {
    return null;
  }

  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") {
      continue;
    }

    if (typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }

    if (typeof block.output_text === "string") {
      parts.push(block.output_text);
      continue;
    }

    const nestedText = (block as Record<string, unknown>).text;
    if (nestedText && typeof nestedText === "object" && typeof (nestedText as Record<string, unknown>).value === "string") {
      parts.push(String((nestedText as Record<string, unknown>).value));
    }
  }

  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  return Promise.race([promise, timeout]);
}

function previewText(input: string, maxChars: number): string {
  const compact = input.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  if (maxChars <= 3) {
    return compact.slice(0, Math.max(0, maxChars));
  }
  return `${compact.slice(0, maxChars - 3)}...`;
}

export type { EasyPruningConfig };
