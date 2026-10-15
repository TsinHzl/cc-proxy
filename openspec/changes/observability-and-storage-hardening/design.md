# 设计文档：observability-and-storage-hardening

## 上下文

- 现有基建：`src/usage.js`（JSON 按天累计）、`src/latency.js`（会话级 TTFT/耗时）、`src/pricing.js`（费用估算）、`src/upstream.js`（上游解析与故障转移在 `src/proxy.js` 内）、`bin/settings-web.js`（设置页 API + 认证链）、`bin/settings-page.js`（内联脚本前端，禁反引号模板字面量）。
- 零运行时依赖约束；Node ≥18 基线；`node:sqlite` 自 Node 22.5 内置（实验标记在 22.x，23.4+ 无需标记）。
- 用量数据固定全局 `~/.cc-proxy/usage.json`，与 config 的 envDir 语义独立。
- 代理日志默认静默（stdout/stderr 会污染 CC Ink UI），任何新输出必须落 API 或文件。

## 目标 / 非目标

**目标：**
- F1-F4 四个功能落地，均通过设置页现有认证链暴露
- 存储层抽象统一 JSON/SQLite 双模式
- 所有新数据采集对主转发链路性能影响可忽略（同步内存操作，无阻塞 IO）

**非目标：**
- 主动探活、推送通知、请求体记录、多项目分组（见 proposal 不在范围）
- 用量数据的多进程并发写协调（单进程代理假设维持）

## 决策

### D1 存储抽象：`src/usage-store.js` 统一接口
```
createUsageStore({ file, now }) → {
  mode: 'sqlite' | 'json',
  record(usage, model),            // 与现有 createUsageTracker.record 同签名
  readRecentDays(days), summary()
}
```
- 探测方式：`await import('node:sqlite')` try/catch + `DatabaseSync` 存在性检测，**不依赖版本号判断**；探测结果进程内缓存。
- SQLite schema：
  - `usage_daily(date TEXT PK, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)`
  - `usage_by_model(date, model, ...)` 复合主键
  - `usage_hourly(hour TEXT PK, ...)` —— 新增小时粒度（本期仅落盘，API 不暴露；为后续排障分析预留）
- JSON 模式：直接委托现有 `createUsageTracker` 逻辑，避免行为分叉。
- 导入：启动时若 SQLite 为空且 usage.json 存在 → 单事务逐日 INSERT → 成功后 `renameSync` 为 `usage.json.imported`；失败 catch → 回滚、保留原文件、本次运行强制 JSON 模式。
- 并发与持久化：打开后执行 `PRAGMA journal_mode = WAL` 与 `PRAGMA busy_timeout = 5000`；导入窗口（事务内）不处理代理请求之外的其他 store 写（导入在启动阶段同步完成，早于请求转发开始，天然串行化）。
- 测试桩注入：`createUsageStore` 接受可选 `sqliteModule` 参数（默认动态 import）；测试传 `{sqliteModule: null}` 强制 JSON 模式、传内存桩模块验证 SQLite 路径，不依赖运行环境 Node 版本。

### D2 告警分级：字段演进而非破坏
**阈值基准（明确语义）**：告警比值 = `max(今日 tokens / alerts.dailyTokens, 今日估算费用 / alerts.dailyCost)`，仅计算已配置的预算项；两项均未配置时 level 恒为 `none`（不告警）。`alerts.dailyTokens` 为现有 token 预算配置；`alerts.dailyCost` 为本期新增的费用预算（数值为美元，> 0）。
`/api/usage` 的 `alert` 从 `{exceeded: boolean, ...}` 扩展为 `{level: 'none'|'warn'|'limit', exceeded: boolean(=level==='limit'), ratio, ...}` —— 保留 `exceeded` 兼容现有前端逻辑，前端新增分支渲染黄色预警。阈值校验：`Number.isFinite && 0 < warn < limit ≤ 1`，非法回退默认 0.8/1.0。

### D3 上游健康：埋点而非拦截
- `src/upstream-health.js` 维护 `Map<upstreamId, {requests, failures, ttfts[]}>`，ttfts 仅保留最近 500 个样本用于百分位（防无限增长）。
- 埋点位置：proxy.js 现有上游转发完成/失败分支与故障转移分支，各加一次同步调用（无 IO）。
- 切换事件：环形数组存最近 20 条 `{time, from, to, reason}`。
- upstreamId 用 upstream.js 的上游 URL 字符串，官方 API 显示为 `api.anthropic.com`。

### D4 请求日志：write-time 脱敏 + 定长环形
- `src/request-log.js` 导出 `createRequestLog({capacity=200})` → `{record(entry), list()}`；数组 push + shift（capacity 小，shift 开销可忽略）。
- 脱敏函数 `redactHeaders(headers)`：键名小写匹配 `authorization`、`x-api-key`、`anthropic-api-key`、`cookie`、`proxy-authorization`、`set-cookie` → 值替换为 `'***' + 末4位`（值长 ≤4 时全部 `***`）。脱敏在 proxy.js 构造 entry 时完成，request-log 模块只存脱敏后数据（纵深防御：模块内二次校验键名）。响应头摘要仅记录脱敏后的认证类头值集合；若实现时发现其他敏感头，按同规则扩展键名清单。
- 记录字段：`{time, model, upstream, status, ttftMs, thinkingRewritten, failover, headers(脱敏摘要)}`。
- 环形缓冲仅在启用设置页时被消费，但记录本身始终开启（成本：每请求一次对象构造，<1μs）。

### D5 API 与前端组织
- 新 API 全部挂在 `bin/settings-web.js` 现有 handleGet/handlePatch 同级路由，复用认证链中间件。
- 前端：settings-page.js 新增两个 card（上游状态、最近请求）+ 看板头部导出按钮与告警条；渲染函数按现有 pattern（createElement + textContent 防注入）。
- 前端加载策略：与 /api/usage 并行请求新 API，失败静默显示"加载失败"占位，不阻塞看板。

### D6 跨进程数据通路：proxy 落盘快照，settings-web 只读
`bin/settings-web.js` 是独立进程，无法读 proxy.js 进程内存。约定共享文件（均在 `~/.cc-proxy/` 下，与 usage.json 同目录）：
- `~/.cc-proxy/runtime/upstream-health.json`：proxy 每次健康埋点变更后 **防抖落盘**（500ms 合并写，`tmp+rename` 原子替换，与 config 写入同一 pattern）；内容为 `getHealthSnapshot()` 结果。
- `~/.cc-proxy/runtime/recent-requests.json`：请求日志每次 record 后同样防抖落盘（write-time 已脱敏，落盘不新增暴露面）。
- settings-web 的 `/api/upstream-health`、`/api/recent-requests` 读 JSON 文件（不存在或损坏 → 返回空快照/空数组），**只读、不缓存**（文件最多滞后 500ms，对面板可接受）。
- proxy 退出时（正常 close 钩子）同步 flush 最终快照。`runtime/` 目录为纯派生数据，加入说明文档，可整目录删除。落盘文件 mode 0600（与 config 写入约定一致）。
- 权衡：文件中转 vs IPC/socket——文件复用现有原子写 pattern，零新协议、settings-web 无需感知 proxy 是否存活，故障面最小，选择文件方案。

## 风险 / 权衡

| 决策 | 权衡 |
|---|---|
| node:sqlite 特性探测而非版本判断 | 实验期 API 变动风险 → 仅用 `DatabaseSync` 基础 API（prepare/run/all），不用实验性高级特性 |
| JSON 模式委托现有 tracker | 双实现路径存在 → 差异仅限存储介质，读写接口统一，测试两模式对照 |
| ttfts 限长 500 样本 | 百分位近似而非全量精确 → 对健康面板展示精度足够，内存有界 |
| 请求日志始终开启 | 用户无法关闭 → 记录量小且仅元数据；如需开关后续加 config 项（不在本期） |
| 环形缓冲用 Array.shift | O(n) 每次写入 → n=200 可忽略；避免引入额外数据结构复杂度 |
| 快照防抖落盘（D6） | 面板数据最多滞后 500ms + 进程崩溃丢失未 flush 增量 → 对观测面板可接受；正常退出有 flush 兜底 |

## 迁移方案

- usage.json → SQLite：见 D1 导入流程；`.imported` 备份保留，用户可手工删除。
- JSON 模式用户（Node 18/20）：零迁移，无感知。
- 前端 alert 字段：新前端仅依赖 level；exceeded 保留供兼容窗口。

## 待决问题（Open Questions）

无 —— 阶段 0 已澄清：SQLite 选型（node:sqlite+JSON 回退）、告警两级 80/100、被动统计、仅元数据脱敏、单一 change。
