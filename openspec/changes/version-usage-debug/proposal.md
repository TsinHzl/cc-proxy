# 变更提案：version-usage-debug

## 背景
cc-proxy 目前作为透明代理只做流量转发与 thinking 渲染。用户在分析后选定三个增强：
- `--version`：当前 `cc-proxy --version` 被透传给 claude，无法查看代理自身版本
- 用量统计：代理天然可见所有响应的 usage 字段（只有代理层才能做到）
- debug 日志：排查第三方网关兼容性问题时需要可回放的请求/响应记录

## 目标范围
**在范围内：**
- `--version` / `-v`：打印 cc-proxy 自身版本（读 package.json）后退出，不启动代理与 claude
- 用量统计（usage tracker）：
  - 从 SSE `message_start` / `message_delta` 事件与非流式 JSON 响应中提取 usage
  - 按「请求次数 + input/output/cache_read/cache_creation tokens」累计
  - claude 退出后代理随之退出前，向 stderr 打印会话用量总结（经 logger，受 CC_PROXY_LOG 门控不污染 Ink UI）
  - 持久化到 `~/.cc-proxy/usage.json`（按天累计），路径可注入测试
- debug 日志：`CC_PROXY_DEBUG=1` 时把每个请求的 method/url/status/耗时 + 请求体与 SSE 事件落盘到 `~/.cc-proxy/logs/`（文件名含时间戳与序号），路径可注入测试
- 单元测试 + 端到端测试覆盖以上三项

**不在范围内：**
- 不做任何终端 UI / TUI 展示（Ink 渲染器雷区，config.yaml 不变量禁止 ANSI 控制码）
- 不做多会话聚合、不做用量配额/预算限制
- 不做请求重写、重试、故障转移
- 设置页不新增菜单项（仅展示层，避免再次踩 Ink 渲染坑）

## 技术方案
- 新增 `src/usage.js`：`createUsageTracker({ usageFile })` — 记录/汇总/落盘，纯函数可测
- 新增 `src/debug-log.js`：`createDebugLog({ dir, enabled })` — 流式写请求/响应记录，容错（写失败静默）
- `src/proxy.js`：在现有请求管道中挂 usage 提取与 debug 写入；usage 在响应结束时累计
- `bin/claude-proxy.js`：`--version` 短路分支；claude 退出后打印用量总结再退出
- `src/settings.js` 不动（usage.json 与 config.json 相互独立）
- 版本号从 package.json 读取（Node ≥18 支持 `import ... with { type: 'json' }` 的前提下用 `createRequire` 兼容读取，避免 ESM JSON module 断言问题）

## 预期影响
- 不影响现有透传与渲染行为（字节兼容不变量不涉及）
- 默认行为零变化：不开 debug 不写文件；用量总结仅在代理关闭时写一次 stderr
- 性能：debug 关闭时零开销路径（enabled 判断短路）

## 风险
- 落盘 IO 在请求关键路径上：debug 写入采用异步追加、失败静默，不阻塞流
- usage.json 并发写：单进程顺序写，无并发问题；损坏时回退空统计
- 时间戳文件名冲突：同毫秒多请求用递增序号兜底
