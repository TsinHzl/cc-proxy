# 任务清单：add-thinking-text-proxy

## 状态：ARCHIVED

## 任务
- [x] T1: 初始化 package.json（ESM、bin: claude-proxy/cc-proxy、npm test）+ README 用法说明 — 验证：`npm pack --dry-run` 显示 bin 字段
- [x] T2: 实现 `src/thinking-text.js` — 移植 agy-cc-proxy 渲染核心（formatThinkingAsText + 流式 transformThinkingAsTextEvents + UA 正则 `/^(?:claude-cli|claude-code)(?:\/|\s|$)/i` 逐字沿用），格式逐字节对齐 — 验证：T4 单测断言与 agy-cc-proxy test-thinking-as-text 一致
- [x] T3: 实现 `src/proxy.js` + `src/upstream.js` — http/https 代理（按 scheme 选模块，不关闭证书校验；上游解析见 spec「上游解析与透传」Requirement）：非 SSE pipe 透传；SSE 逐事件缓冲解析，thinking 块文本化改写，非 CC UA 原样透传；请求侧移植 `stripThinkingTextHistory` 剥离历史已渲染文本块 — 验证：本地 mock 上游 + curl 手测 + T4 集成断言
- [x] T4: 编写 node:test 测试 `test/thinking-text.test.mjs` — 覆盖：渲染格式（header/跳空行/无尾随换行/字节上限）、SSE 跨 chunk 缓冲、非 thinking 事件透传、UA 门控 — 验证：`npm test` 全绿
- [x] T5: 实现 `bin/claude-proxy.js` — listen → 注入 ANTHROPIC_BASE_URL → spawn claude（参数透传、stdio 继承、退出码透传、SIGINT 联动） — 验证：`node bin/claude-proxy.js --version` 输出 CC 版本且代理进程随之退出

## 验收标准
- [x] `npm test` 全部通过（渲染格式与 agy-cc-proxy test-thinking-as-text 基准逐字节一致）— 24/24 通过
- [x] `claude-proxy` / `cc-proxy` 命令启动代理并进入 Claude Code，`ANTHROPIC_BASE_URL` 已指向本地代理 — 实测 `node bin/claude-proxy.js --version` → `2.1.231 (Claude Code)`
- [x] CC 会话中深度思考以 `> 💭 Thinking` 灰色引文流式渲染，无多余竖线段（以 T4 集成断言「输出字节序列与 agy-cc-proxy 基准一致」为可自动化代理）
- [x] 非 CC 客户端直连代理时流量原样透传（UA 门控生效，含 `claude-cli` 无版本号 UA 判匹配）

## 归档备注
- 第 1 轮 CR 已修：#1 High（非流式文本化未实现）、#2 Medium（挤行）、#5 Low（buffer 声明 TDZ）、#3 Medium（parseEvent null 中断流）、#6 Low（JSDoc 过期）、#7 Low（SSE 背压）。
- 遗留 known issue（用户选择不修）：`src/upstream.js:17` 注释「claude-tap build_upstream_url semantics」与实现不符，已记录至 `~/.claude/cr-known-issues/cc-proxy-2ad4c89ba095.md`。
- 第 2 轮 CR 经用户明确指示跳过。
