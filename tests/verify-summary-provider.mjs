import plugin from "../dist/index.js";

const logs = [];
const handlers = new Map();

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-key";

globalThis.fetch = async (url, init = {}) => {
  if (!String(url).includes("openrouter.ai/api/v1/chat/completions")) {
    return {
      ok: false,
      status: 500,
      text: async () => "unexpected url",
      json: async () => ({}),
    };
  }

  const body = JSON.parse(String(init.body || "{}"));
  return {
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({
      id: "mock",
      model: body.model,
      choices: [{ message: { content: "这是来自 OpenRouter 的摘要结果（测试）" } }],
    }),
  };
};

const api = {
  pluginConfig: {
    pruning_threshold: 1,
    trigger_every_n_tokens: 1,
    keep_recent_tokens: 1,
    keep_recent_messages: 0,
    soft_threshold: 0,
    hard_threshold: 0,
    detail_threshold: 0,
    detail_pruning_mode: "model_summary",
    detail_summary_model: "openrouter/stepfun/step-3.5-flash:free",
    detail_summary_timeout_ms: 3000,
    detail_summary_max_chars: 200,
    debug_summary_io: true,
    debug_pruning_io: false,
    debug_preview_chars: 120,
  },
  config: {},
  logger: {
    info: (m) => logs.push(`[INFO] ${m}`),
    warn: (m) => logs.push(`[WARN] ${m}`),
    debug: (m) => logs.push(`[DEBUG] ${m}`),
    error: (m) => logs.push(`[ERROR] ${m}`),
  },
  on: (name, fn) => handlers.set(name, fn),
};

plugin.register(api);

const before = handlers.get("before_agent_start");
if (typeof before !== "function") {
  throw new Error("before_agent_start hook not registered");
}

const messages = [
  {
    role: "toolResult",
    content: [{ type: "text", text: "X".repeat(4000) }],
  },
  {
    role: "assistant",
    content: [{ type: "text", text: "Y".repeat(4000) }],
  },
];

await before({ messages }, { sessionKey: "test:summary-provider" });

const serialized = JSON.stringify(messages);
const usedOpenRouter = logs.some((l) => l.includes("summary_api=openrouter.chat"));
const hasSummaryText = serialized.includes("Model summary") || serialized.includes("摘要结果");

console.log("usedOpenRouter:", usedOpenRouter);
console.log("hasSummaryText:", hasSummaryText);
console.log("log_hit:", logs.filter((l) => l.includes("summary_api=")).slice(-1)[0] || "none");

if (!usedOpenRouter || !hasSummaryText) {
  console.error("\n--- logs ---\n" + logs.join("\n"));
  process.exit(1);
}

console.log("PASS verify-summary-provider");
