# Easy Pruning - 验证与监控指南（Maintainers）

> 这份文档面向维护者/运维人员，用于快速验证 `model_summary` 链路和线上监控。

---

## 1) 快速验证

### `npm run verify`

本地验证脚本（推荐首先运行）：

- ✅ 检查编译输出 `dist/index.js`
- ✅ 读取 OpenRouter 凭据（优先 `OPENROUTER_API_KEY`，否则尝试 OpenClaw 的 `auth-profiles.json`）
- ✅（可选）发起一次真实 OpenRouter 调用
- ✅（可选）检查 `openclaw.json` 中 easy-pruning 配置阈值合理性

执行：

```bash
npm run build
npm run verify
```

如果你希望跳过真实 API 调用（避免消耗额度），可设置：

```bash
EASY_PRUNING_VERIFY_LIVE=0 npm run verify
```

---

## 2) 线上监控

### `npm run monitor`

监控 Easy Pruning 的日志文件，输出最近一次 prune 的统计信息，并提示 detail 是否触发。

执行：

```bash
npm run monitor
```

环境变量（可选）：

- `EASY_PRUNING_LOG=/path/to/easy-pruning.log`
- `OPENCLAW_HOME=/path/to/.openclaw`
- `OPENCLAW_LOG_DIR=/path/to/.openclaw/logs`

---

## 3) OpenRouter 凭据复用（说明）

插件和验证脚本**不会保存** API Key。

OpenRouter Key 的读取优先级：

1. `OPENROUTER_API_KEY`
2. OpenClaw `auth-profiles.json`（常见位置：`$OPENCLAW_HOME/auth-profiles.json` 或 `$OPENCLAW_HOME/agents/<name>/agent/auth-profiles.json`）

示例格式（请勿提交真实 key 到仓库）：

```json
{
  "profiles": {
    "openrouter:default": {
      "type": "api_key",
      "provider": "openrouter",
      "key": "<YOUR_OPENROUTER_API_KEY>"
    }
  }
}
```

---

## 4) 触发 detail 的配置建议

要稳定触发 detail 区域（尤其是 `model_summary`），建议：

- `pruning_threshold` ≥ 80k（会话足够长才有意义）
- `keep_recent_tokens` ≤ 20k–30k（越高越容易把 detail 区域覆盖掉）
- `detail_threshold` 通常 ≥ 0.7

---

**最后更新**: 2026-03-10
