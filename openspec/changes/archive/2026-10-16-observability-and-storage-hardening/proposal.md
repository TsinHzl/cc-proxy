# 变更提案：observability-and-storage-hardening

## 背景

cc-proxy 已具备用量看板、多上游故障转移、延迟统计（latency.js）与 CC_PROXY_DEBUG 请求日志，但四方面能力仍不完整：

1. **看板只能看不能算**：多上游（按量计费）场景下用户关心"月度花费、哪个模型烧钱、是否异常飙升"，但无导出能力，告警为单阈值一级，缺少预算预警。
2. **故障转移黑盒**：3a07b37 引入的自动切换对用户不可见——不知道当前活跃上游、各上游成功率/延迟、何时因什么切换。
3. **usage.json 结构性隐患**：每次请求全量读写 JSON 文件，30 天后文件增大、并发写有丢失风险，无法做小时级粒度分析。
4. **排障体验差**：CC_PROXY_DEBUG 日志需手动开启并翻文件，无法快速回答"这个请求为什么没改写/为什么切了上游"。

## 目标范围

**在范围内：**

- **F1 用量导出与分级告警**：设置页看板新增 CSV / JSON 导出（复用现有 /api/usage 30 天明细）；告警升级为 80%（预警）/100%（超限）两级，比值基准 = max(今日 tokens / alerts.dailyTokens, 今日估算费用 / alerts.dailyCost)（仅计已配置项），阈值在 config.json 中可配置。
- **F2 上游健康面板（被动统计）**：设置页新增"上游状态"卡片，展示每个上游的真实请求成功率、TTFT p50/p95（TTFT 样本每上游限最近 500 个）、请求次数、当前活跃上游、最近一次故障转移时间与原因；不做任何后台主动探活请求。健康数据由 proxy 进程落盘到 `~/.cc-proxy/runtime/` 共享文件（防抖 + 原子替换），settings-web 进程读文件返回，解决跨进程可见性。
- **F3 存储优化（node:sqlite + JSON 回退）**：动态 import 探测 `node:sqlite`（特性检测，不依赖版本号，测试可注入探测结果），可用时用量落盘改用 SQLite（启用 WAL；含小时级粒度表）；否则自动回退现有 JSON 模式，行为与数据格式完全兼容；现有 usage.json 历史数据在首次切换时于请求转发开始前单事务导入 SQLite。
- **F4 请求级 debug 视图（仅元数据）**：环形缓冲区（内存，最近 200 条）记录每请求元数据（时间、模型、上游、状态码、TTFT、是否 thinking 改写、是否故障转移），并随健康快照同 pattern 落盘供 settings-web 读取；设置页新增"最近请求"表与展开详情；详情中响应头摘要必须脱敏（Authorization/API key 仅显示末 4 位，write-time redaction）；默认不落盘任何请求/响应体。

**不在范围内：**

- 后台定时探活（用户已明确选择纯被动统计）
- 第三方 SQLite 依赖（坚持零运行时依赖原则）
- 请求/响应体落盘（隐私约束）
- 多项目用量分组（可行性待验证，另行提案）
- 主动推送通知（邮件/webhook 等，告警仅限设置页展示）

## 技术方案

- **F1**：`bin/settings-web.js` 新增 `GET /api/usage/export?format=csv|json`（复用 buildUsageReport 的 30 天聚合）；CSV 含日期/请求数/各 token 字段/费用。告警阈值读 `config.json` 的 `usageAlert.warnThreshold`（默认 0.8）/`usageAlert.limitThreshold`（默认 1.0），`src/usage.js` 告警计算升级为返回 `{level: 'none'|'warn'|'limit', ratio, ...}`。
- **F2**：新增 `src/upstream-health.js`：基于现有 latency.js 的请求结果记录（成功/失败、TTFT、上游标识），提供 `getHealthSnapshot()`；故障转移事件在 proxy.js 现有切换逻辑处埋点记录。快照防抖落盘到 `~/.cc-proxy/runtime/upstream-health.json`（tmp+rename 原子替换），`bin/settings-web.js` 新增 `GET /api/upstream-health` 读该文件（跨进程只读，不依赖进程内通信）。
- **F3**：新增 `src/usage-store.js` 抽象层：启动时动态 `import('node:sqlite')` 特性探测（接受测试注入探测结果），成功用 SQLite（`PRAGMA journal_mode=WAL`；按天/按小时聚合表），失败回退 JSON。`usage.json` 首次切换时在请求转发开始前单事务导入，成功后重命名为 `usage.json.imported` 保留备份。
- **F4**：新增 `src/request-log.js`：内存环形缓冲（定长 200），proxy.js 在请求完成处埋点写入，并防抖落盘到 `~/.cc-proxy/runtime/recent-requests.json`；`GET /api/recent-requests` 读文件返回，头部摘要按 key 脱敏（`Authorization`、`x-api-key` 仅末 4 位，write-time redaction）。
- 所有新 API 挂在现有设置页认证链之后（Host/Origin/nonce/token），不新增端口。

## 预期影响

- 现有功能：/api/usage、看板渲染、故障转移、thinking 改写行为不变；仅告警字段从布尔升级为分级对象（前端同步适配，JSON 模式下 usage.json 格式不变）。
- 性能：SQLite 模式下每次请求从"全量读+全量写"降为单条 INSERT（批量可合并）；环形缓冲内存占用 < 100KB。
- 兼容性：Node 18/20 用户无感（JSON 回退）；设置页在两个模式下功能一致，看板 UI 标注当前存储模式。
- 测试：现有 95 个设置页测试 + usage 测试全部保持通过；新增 store 抽象层、告警分级、脱敏、健康聚合的单元测试。

## 风险

| 风险 | 应对 |
|---|---|
| node:sqlite 在不同 Node 版本 API 有差异 | 动态 import + 特性检测（而非版本号判断），失败静默回退 JSON；测试通过注入探测结果覆盖两种模式，不依赖环境版本 |
| usage.json → SQLite 导入中断导致数据不一致 | 导入在单事务内完成且早于请求转发开始（天然串行化），失败回滚并保留原文件；成功后才重命名备份；SQLite 启用 WAL + busy_timeout |
| 跨进程数据可见性（settings-web 读不到 proxy 内存） | proxy 健康快照/请求日志防抖落盘到 `~/.cc-proxy/runtime/` 共享文件（tmp+rename 原子替换），settings-web 只读文件；面板可接受 ≤500ms 滞后 |
| 快照落盘丢失（proxy 崩溃时未 flush） | 面板为派生观测数据，丢失仅影响最近增量；正常退出有 close 钩子 flush 兜底 |
| debug 视图意外泄漏密钥 | 脱敏在写入环形缓冲前完成（write-time redaction），落盘文件同样只含脱敏数据；测试覆盖常见 key 头 |
| 环形缓冲在高并发下竞态 | 单线程事件循环内同步 push，无跨线程共享 |
| 设置页体量继续膨胀（settings-page.js 已超 800 行） | 前端渲染函数随对应后端模块拆分放置，遵守文件 ≤800 行约束 |

## 验收标准（量化）

1. 导出：`GET /api/usage/export?format=csv|json` 返回 200，CSV 行数 = 近 30 天有数据天数 + 1 表头行，且与 /api/usage 同日数值逐项相等；未知 format 返回 400。
2. 告警：预算 10、费用 8.5 → level=warn；费用 10.5 → level=limit；费用 0 或无预算配置 → level=none；warnThreshold ≥ limitThreshold 的配置被拒收回退 0.8/1.0。测试覆盖 79%/80%/99%/100% 四个边界。
3. 上游健康：模拟 10 次请求（8 成功 2 失败）+ 1 次切换后，快照 successRate=0.8、ttftP50/p95 与注入样本一致、切换事件含时间与原因；全程代理向上游发出的网络请求数 = 请求数本身（无探活）。
4. 存储：注入桩测试下 SQLite 模式与 JSON 模式对同一组 record 输入产生结构一致的 /api/usage 数据；导入 3 天历史 usage.json 后行数一致且原文件更名为 `.imported`；注入导入失败时原文件保留、本次运行 JSON 模式。
5. 请求日志：含 `Authorization: Bearer sk-ant-1234567890` 的请求记录后，缓冲与落盘文件中该值均为 `***7890`；201 条请求后缓冲长度恒为 200 且最旧条目被移除；请求/响应体字段不出现在任何记录中。
6. 回归：`node --test --test-timeout=15000 "test/"*.test.mjs` 0 fail（现有 95+ 用例全过）。
