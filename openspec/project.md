# 项目上下文

## 技术栈
- Node.js >= 18 (ESM)，零运行时依赖（仅用 Node 内置模块 http / https / child_process /
  fs / path / os / crypto / readline；`node:sqlite` 为可选能力，动态 import 探测）
- 包管理：npm；全局 bin 提供 `claude-proxy` / `cc-proxy` 命令（`npm link` 注册，`install.sh` 一键装）
- 无 build、无 lint 步骤；测试框架 node:test

## 架构约定
- 单一职责：本地透明代理，监听 127.0.0.1 随机端口，透传 Anthropic Messages API 流量到上游
  （启动时的 ANTHROPIC_BASE_URL，缺省 https://api.anthropic.com），随后替换该变量为本地地址并
  spawn `claude`，退出码与 stdio 全透传
- 请求侧改写（仅 UA 匹配 `claude-cli`/`claude-code`）：thinking 历史剥离、effort 覆写、
  system prompt 捕获与覆写、Suggestion Mode 识别与拦截
- 响应侧改写（仅 CC UA + SSE / message JSON）：thinking→text 流式文本化、usage 提取
  （内部真实值）、usage 展示缩放（客户端可见值）
- 非 CC UA、非 SSE、非 message JSON、错误响应一律原样透传
- 多上游故障转移：`upstream.js` 负责重试与切换（同上游仅 502/503/529 重试 1s/2s/4s；
  429/500 立即切换)，`upstream-health.js` 采集样本并在 ≥3 条时按成功率降序 / TTFT p50 升序
  重排，`upstream-breaker.js` 提供熔断（连续失败 ≥3 → open → 30s 冷却 → half-open 探测），
  全部熔断时按配置序兜底
- 三个定向特性（effortOverride / usageScale / forwardSuggestionMode）共用 `base-url-match.js`
  的规范化与命中原语：空列表 = 全局生效，多条命中取路径最具体，未命中回退全局值
- 用量存储抽象层 `usage-store.js`：`node:sqlite` 可用时落 `usage.db`（WAL + busy_timeout），
  否则回退 `usage.json`；首次导入历史 JSON 后改名 `.imported` 备份
- 设置页安全链：仅 127.0.0.1 → Host 校验 → Origin 校验 → 一次性 bootstrap nonce（30s / 256 容量，
  单次消费）→ capability token；token 不进 URL 与终端输出。页面全关后 2s 退出（SSE 租约）
- 代理请求管道无状态；设置服务不提供账号系统
- 代理内部日志默认静默（`src/logger.js`），任何 stdout/stderr 都会经 stdio 继承污染 Ink UI

## 目录结构
```
bin/claude-proxy.js                      # CLI 入口：--version / --setting / 起代理 → 注入 env → spawn claude
bin/settings-web.js                      # 本地 Web 设置服务、受保护 API、浏览器启动
bin/settings-page.js                     # 设置页 HTML（模板 + 内联脚本 + 样式，bootstrap nonce 注入）
bin/settings-page-targetlist.js          # 定向目标上游列表工厂（usageScale / effortOverride / forwardSuggestionMode 共用）
bin/settings-page-usage.js               # 用量看板脚本片段
bin/settings-page-health.js              # 上游状态看板脚本片段
bin/settings-page-recent-requests.js     # 最近请求表脚本片段
bin/settings-session.js                  # 页面 SSE 租约、定时器与 socket 关闭流程
bin/settings-cli.js                      # 旧终端设置菜单（CLI 已不调用，仅测试引用）

src/proxy.js                             # HTTP 代理服务器与响应改写（SSE / 非流式 JSON）
src/upstream.js                          # 上游地址解析、同上游重试与故障转移
src/upstream-health.js                   # 上游健康统计（滚动成功率 / TTFT 样本）
src/upstream-breaker.js                  # 上游熔断器
src/thinking-text.js                     # thinking → 文本化渲染（核心特性，移植自 agy-cc-proxy）
src/suggestion-mode.js                   # Suggestion Mode 请求识别与空响应构建
src/system-prompt.js                     # system 字段捕获与覆写（string / blocks 双形态）
src/settings.js                          # 配置归一化、默认值与原子写盘
src/base-url-match.js                    # base URL 规范化与定向命中原语（三特性共用）
src/usage.js                             # usage 提取与按天持久化（JSON 模式）
src/usage-store.js                       # 用量存储抽象层（SQLite / JSON 双模 + 历史导入）
src/usage-scale.js                       # 客户端可见 usage 缩放
src/pricing.js                           # 模型单价解析与费用估算、缓存命中率
src/latency.js                           # 会话级延迟统计（TTFT，仅内存）
src/request-log.js                       # 最近请求环形缓冲（200 条，头脱敏）
src/debug-log.js                         # CC_PROXY_DEBUG=1 请求级日志
src/logger.js                            # 静默日志（CC_PROXY_LOG=1 恢复）

test/*.test.mjs                          # 与 src 一一对应的 node:test 套件（28 个文件 / 463 用例）
openspec/config.yaml                     # 约束注入（context + rules）
openspec/specs/                          # 已归档需求事实源（4 个 capability）
openspec/changes/                        # 提案（进行中）与 archive/（已归档）
```

## 关键文件
- `src/proxy.js` — 请求/响应管道枢纽，注入 usageTracker / latencyTracker / debugLog /
  upstreamHealth / upstreamBreaker / requestLog / systemPromptCapture 等可选依赖
- `src/thinking-text.js` — 渲染格式不变量所在（`MAX_THINKING_TEXT_BLOCK_BYTES` = 256KB）
- `src/settings.js` — `DEFAULT_CONFIG` 是全部默认行为的单一事实源
- `~/.cc-proxy/` — `config.json`、`usage.db|usage.json`、`captured-system-prompt.json`、
  `runtime/`（可整目录删除）、`logs/`

## 开发约定
- node:test 测试；依赖通过工厂参数注入（如 `sqliteModule` 传 null 强制 JSON 模式），
  网络路径用真实 `http.createServer` 而非 mock 框架
- 全量 `npm test` 约 45s（463 用例）；已知 Node 25.x 下 `npm test` 可能以
  `--test-concurrency=0` 挂起，此时改用 `node --test --test-timeout=15000 "test/"*.test.mjs`
- 最小实现：不做 claude-tap 的 trace / viewer / 多客户端功能
- 不生成 ANSI 控制码、不新增终端 UI（Ink 渲染器雷区）