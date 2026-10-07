# 变更提案：suggestion-mode-toggle

## 背景
Claude Code 在每轮主对话结束后会自动发起一次 Suggestion Mode 输入建议请求（末条 user 消息以 `[SUGGESTION MODE` 开头，携带全量上下文却只产出候选短语）。经第三方上游转发时产生额外全价计费请求，并可能影响主对话 prompt cache。参考 kiro2cc-proxy 的同名功能，cc-proxy 增加默认关闭的拦截开关，可在设置页打开。

## 目标范围
**在范围内：**
- `src/suggestion-mode.js`：Suggestion Mode 请求识别（末条 user 消息、字符串 content `starts_with` / 块数组仅首块命中）与空响应构造（流式 SSE 事件序列 / 非流式 JSON，结构完整、usage 全 0）
- `src/settings.js`：新增顶层布尔配置 `forwardSuggestionMode`（默认 `false`）；**`normalizeConfig` 与 `writeConfig` 必须同步适配顶层键合并**——现有 `writeConfig` 构造 merged 时只保留 `thinkingWindow` 子对象，会把其他顶层键静默丢弃，若不适配则已保存的开关会在下一次 thinkingWindow 写盘时被重置（数据丢失路径）
- `src/proxy.js`：CC UA 请求在转发前检测；开关关闭且命中建议请求时直接返回空响应（按请求 `stream` 字段分流），不转发上游；**拦截路径完全不调用 `usage.record`（usage 统计零增量）、不写 debug 日志**；开关打开或非命中请求行为不变
- `bin/claude-proxy.js`：启动时 `readConfig()` 并把 `forwardSuggestionMode` 传入 `createProxyServer`
- `bin/settings-cli.js`：设置页从"纯展示 + 回车/Esc 退出"改版为带编号项的菜单——新增数字键 `1` 切换 `forwardSuggestionMode`（即时写盘并以新状态重绘），涉及菜单渲染（menuText）、按键路由（runSettingsMenu 键处理）、非 TTY 行解析三处适配；回车/Esc 退出不变
- README.md / README.en.md：新增「Suggestion Mode 输入建议」章节
- 测试：suggestion-mode 单元、proxy 端到端（拦截/放行两态）、settings 读写与设置页按键

**不在范围内：**
- 运行时热切换（kiro2cc-proxy 的设置页热生效；cc-proxy 为每次会话启动时读一次配置）
- 环境变量覆盖（`FORWARD_SUGGESTION_MODE`）
- 非 CC UA 流量的任何处理（维持原样透传）

## 技术方案
- 识别逻辑移植 kiro2cc-proxy `is_suggestion_mode_request` 判据：`payload.messages` 最后一条为 `role === "user"`；content 为字符串时 `startsWith("[SUGGESTION MODE")`；content 为数组时仅首块 `type === "text"` 且 text 以标记开头
- 空响应结构照搬 kiro2cc-proxy `suggestion_mode_response`：非流式返回完整 message JSON（空 text、`stop_reason: "end_turn"`、usage 全 0）；流式返回 `message_start → content_block_start(空 text) → content_block_stop → message_delta(end_turn) → message_stop` 五事件 SSE
- proxy.js 挂接点：CC UA 请求解析 body 后、`forwardRequest` 之前判断；命中且开关关闭时直接写响应并 return，跳过 usage 统计与 debug 日志样本（拦截请求不产生上游用量）
- 配置流：`bin/claude-proxy.js` 读 `readConfig().forwardSuggestionMode` → `createProxyServer({ forwardSuggestionMode })`，proxy 模块只收布尔值，不感知配置文件

## 预期影响
- 开关语义与 kiro2cc-proxy 一致：`forwardSuggestionMode` 为**放行开关**，默认 `false`（关闭 = 拦截生效），即默认拦截建议请求；用户需求"默认关闭、可在设置中打开"指的即是该放行开关——打开后建议请求转发上游展示输入建议
- 非 CC 流量、主对话流量、usage 统计、debug 日志路径均不受影响
- 新增 `src/suggestion-mode.js` 一个模块 + 现有 4 个文件的挂接改动

## 风险
- 误伤面：正常消息恰好以 `[SUGGESTION MODE` 开头会被拦截 → 沿用 kiro2cc-proxy 的 starts_with + 仅首块判据，其单元测试验证了误伤边界；单测同时覆盖"历史中间位置出现标记消息不拦截"（必须为末条 user 消息）反例；且设置页可一键关闭
- 配置回写丢失：`writeConfig` 顶层键合并不适配会静默重置已保存开关 → 已在任务 2 中列为强制适配项，单测覆盖"先写开关、再写 thinkingWindow、开关保留"
- CC 版本升级改变建议请求标记格式 → 拦截失效退化为放行（不破坏主对话），仅失去省费效果
