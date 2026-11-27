# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                                          # 全量测试（node:test）
node --test "test/thinking-text.test.mjs"         # 运行单个测试文件
node --test --test-name-pattern="历史剥离" test/thinking-text.test.mjs  # 按名称过滤
node bin/claude-proxy.js                          # 不经 npm link 直接运行 CLI
```

环境要求 Node.js ≥ 18（ESM，零运行时依赖，仅用 `node:http`/`node:https`/`child_process` 等）。无 lint / build 步骤。

已知环境问题：Node 25.x 下 `npm test` 会以 `--test-concurrency=0` 挂起；此时改用 `node --test --test-timeout=15000 "test/"*.test.mjs`。

全量 463 用例约 45s，单文件测试秒级——迭代时优先单文件。关键环境变量：`CC_PROXY_LOG=1`（stderr 日志 + 退出汇总）、`CC_PROXY_DEBUG=1`（请求落盘 `~/.cc-proxy/logs/`）、`CLAUDE_PROXY_BIN`（spawn 的可执行名，默认 `claude`）、`CC_PROXY_CONFIG_DIR`（仅旧终端菜单 `bin/settings-cli.js` 读取，主代理与 Web 设置页不读）。

## Architecture

cc-proxy 是 Claude Code 的本地透明代理（Anthropic Messages API in → 上游转发 out），核心链路：

```
bin/claude-proxy.js   CLI 入口：--version / --setting / 起代理 → 注入 env → spawn claude
        │
src/proxy.js          HTTP 代理核心：请求/响应改写、SSE 事件级处理
  ├─ src/upstream.js          上游地址解析（ANTHROPIC_BASE_URL 或官方 API）与转发
  ├─ src/base-url-match.js    定向匹配原语（base URL 规范化 + 命中判定；Set 形态供 usageScale，
  │                            条目形态 buildBaseUrlTargetEntries / resolveBaseUrlTargetValue 供
  │                            effortOverride 取条目档位、forwardSuggestionMode 取转发策略，含
  │                            规范串去重与路径长度降序）
  ├─ src/upstream-breaker.js  上游熔断器（连续失败≥3 → open 跳过 → 30s 冷却 half-open 探测恢复）
  ├─ src/upstream-health.js   上游健康统计（滚动窗口成功率）→ ~/.cc-proxy/runtime/upstream-health.json
  ├─ src/thinking-text.js     thinking→text 流式改写（核心特性）
  ├─ src/suggestion-mode.js   [SUGGESTION MODE 请求识别与空响应拦截
  ├─ src/system-prompt.js     system 字段捕获（落盘 captured-system-prompt.json）与覆写（string/blocks 双形态）
  ├─ src/usage.js             token 用量提取 → ~/.cc-proxy/usage.json（按天）
  ├─ src/usage-scale.js       客户端可见 usage 缩放（usageScale 配置；output 不缩放，内部统计真实值；baseUrls 定向匹配）
  ├─ src/usage-store.js       用量存储抽象层（JSON / SQLite 双模式探测 + 历史导入）
  ├─ src/pricing.js           模型单价解析（config 覆盖内置价表，精确→前缀）
  ├─ src/latency.js           会话级延迟统计（TTFT 采样，退出时汇总）
  ├─ src/request-log.js       最近请求环形缓冲 200 条 → ~/.cc-proxy/runtime/recent-requests.json
  ├─ src/debug-log.js         CC_PROXY_DEBUG=1 请求级日志 → ~/.cc-proxy/logs/
  └─ src/logger.js            静默日志（见下方关键约束）
bin/settings-web.js   cc-proxy --setting：本地 Web 设置页 + 受保护 API
  ├─ bin/settings-page.js     设置页 HTML（模板 + 内联脚本，bootstrap nonce 注入）
  ├─ bin/settings-page-targetlist.js     定向目标上游列表工厂（usageScale / effortOverride /
  │                                        forwardSuggestionMode 共用；按列表描述渲染行内
  │                                        比例 / 档位 / 转发策略下拉与备注输入）
  ├─ bin/settings-page-{usage,health,recent-requests}.js  看板脚本片段（由 settings-page.js 内联）
  ├─ bin/settings-cli.js      旧终端设置菜单（CLI 已不调用，仅测试引用）
  └─ bin/settings-session.js  SSE 租约生命周期（页面全关 2s 后退出等）
src/settings.js       ~/.cc-proxy/config.json 读写（缺失/损坏回退默认值；effortOverride.baseUrls 走
                      cleanEffortTargets，usageScale.baseUrls 走 cleanScaleTargets，
                      forwardSuggestionMode.baseUrls 走 cleanSuggestionTargets，均为混合形态校验 +
                      规范串去重）
```

数据流：UA 匹配 `claude-cli`/`claude-code` 的 SSE 流中，thinking 块被改写为 `> 💭 Thinking` dim blockquote 文本流（移植自 agy-cc-proxy）；多轮请求中已渲染的历史思考文本在转发前剥离，防止上下文膨胀。非 CC 客户端、非 SSE、非 message JSON 流量一律原样透传。

多上游选路（`upstream.js` + `upstream-health.js` + `upstream-breaker.js` 协同）：候选 = 主上游 + `config.upstreams`；同上游仅对 502/503/529 重试（1s/2s/4s），429/500 立即切换；健康样本 ≥3 才按「成功率降序、TTFT p50 升序」重排，样本不足保持配置序；全部熔断时忽略熔断按原序尝试（熔断非最终否决）。

`DEFAULT_CONFIG`（`src/settings.js`）中最易踩的默认值：`effortOverride` **默认开启且为 high**（不改配置也会改写请求体 effort）；`thinkingAsText` 默认 true、`forwardSuggestionMode` 默认 false（拦截建议请求回空响应）；`usageScale` / `systemPromptOverride` / `alerts` 默认关闭。三特性共用的 `baseUrls` 定向列表，空 = 全局生效。

## Critical invariants

- **thinking→text 渲染格式必须与 agy-cc-proxy `src/cloudcode/thinking-text-streamer.js` 逐字节兼容**（header 行 + `\n> ...` dim 行、空行跳过、末行无尾随换行）。永远不输出 ANSI 光标控制码（滚动窗口方案因与 Claude Code Ink 渲染器不兼容已废弃）。
- **不参与 thinking 转换的流量必须原样透传**：非 message JSON、错误响应、非 SSE、非 CC UA。
- **代理内部日志默认静默**（`src/logger.js`）。任何 stdout/stderr 输出都会经 stdio 继承泄漏进 Claude Code 的 Ink UI。调试用 `CC_PROXY_LOG=1`（stderr）与 `CC_PROXY_DEBUG=1`（请求日志落盘）。
- 设置页安全链：Host 校验 → Origin 校验 → 一次性 bootstrap nonce（30s/256 容量）→ token；仅监听 127.0.0.1。改动认证链时须保持 token 不进 URL/终端输出。
- 配置写入使用同目录临时文件 + rename 原子替换，新文件 mode 0600、更新保留原 mode。
- `~/.cc-proxy/` 状态全景：`config.json`、`usage.db|usage.json`（`node:sqlite` 探测优先，失败回退 JSON，首次自动导入历史 usage.json）、`captured-system-prompt.json`、`runtime/`（upstream-health.json、recent-requests.json，mode 0600，**可整目录删除**）、`logs/`（可删）。

## OpenSpec

本项目启用 OpenSpec 规范驱动开发（`openspec/`）：`openspec/project.md` 为项目上下文，`openspec/specs/` 为已归档需求事实源（cc-proxy-settings、claude-thinking-text 等 capability），行为级变更应先建 `openspec/changes/<name>/` 提案。用户级 OpenSpec 强制流程（触发评估、AskUserQuestion 门控、sub-agent CR）定义在 `~/.claude/rules/00-openspec-gate.md`，优先于技能默认流程。
