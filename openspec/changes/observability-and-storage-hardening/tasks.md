# 任务清单：observability-and-storage-hardening

## 状态：IN_PROGRESS

## 任务

### F1 用量导出与分级告警
- [x] T1 新增 `GET /api/usage/export?format=csv|json`（30 天聚合，CSV 含 date/requests/各 token 字段/费用；JSON 复用 buildUsageReport；未知 format 返回 400）——验证：node:test 覆盖两种 format 的响应头、内容与 400 分支
- [x] T2 告警分级：config.json 支持 `usageAlert.warnThreshold`(默认0.8)/`limitThreshold`(默认1.0)；比值基准 = max(今日 tokens/alerts.dailyTokens, 今日估算费用/alerts.dailyCost)，仅计已配置项，均未配置 level=none；告警计算返回 `{level:'none'|'warn'|'limit', ratio}`，/api/usage 的 alert 字段升级（保留 exceeded=level==='limit' 兼容）——验证：阈值边界测试（79%/80%/99%/100%）+ 无预算配置 + 非法阈值回退
- [x] T3 设置页看板接入两级告警展示（黄色预警条 + 红色超限，含 ratio）与导出按钮（下载 CSV/JSON）；渲染函数遵守文件 ≤800 行约束——验证：设置页测试断言新节点与文本

### F2 上游健康面板（被动统计）
- [x] T4 新增 `src/upstream-health.js`：记录各上游请求成功/失败、TTFT（样本限最近 500/上游）、次数，提供 `getHealthSnapshot()`（含 p50/p95）；快照防抖落盘到 `~/.cc-proxy/runtime/upstream-health.json`（tmp+rename 原子替换，500ms 合并写，进程退出 flush）；proxy.js 故障转移处埋点记录切换事件（时间+原因，环形 20 条）——验证：单元测试覆盖记录、百分位、切换事件与落盘/损坏文件回退
- [ ] T5 新增 `GET /api/upstream-health`（settings-web 读落盘快照文件，缺失/损坏返回空快照）+ 设置页"上游状态"卡片（活跃上游、各上游成功率/TTFT/次数、最近切换）；渲染函数遵守 ≤800 行——验证：API 测试（含空快照分支）+ 页面节点断言

### F3 存储优化（node:sqlite + JSON 回退）
- [ ] T6 新增 `src/usage-store.js` 抽象层：`createUsageStore({file, sqliteModule?})` 动态 import('node:sqlite') 特性探测（不依赖版本号，可注入），成功用 SQLite（`PRAGMA journal_mode=WAL`+`busy_timeout=5000`，含按天/按小时聚合表）、失败回退 JSON——验证：注入桩强制两模式对照测试（同一 record 输入 → readRecentDays/summary 结构一致）
- [ ] T7 历史导入与接入：启动时（早于请求转发）SQLite 为空且 usage.json 存在 → 单事务逐日 INSERT → 成功 rename `.imported`；失败回滚、保留原文件、本次运行强制 JSON 模式；usage.js 与 settings-web.js 读写路径接入 store 抽象层，两模式下 /api/usage、看板行为一致，页面标注当前存储模式——验证：导入成功/失败注入测试 + 两模式行为对比测试

### F4 请求级 debug 视图
- [ ] T8 新增 `src/request-log.js`：内存环形缓冲 200 条，仅元数据（时间/模型/上游/状态码/TTFT/是否 thinking 改写/是否故障转移），头部摘要 write-time 脱敏（redactHeaders 匹配 authorization/x-api-key/anthropic-api-key/cookie/proxy-authorization/set-cookie → '***'+末4位，≤4 位全 `***`，模块内二次校验键名，响应头摘要仅记录脱敏后认证类头值集合）；record 后防抖落盘 `~/.cc-proxy/runtime/recent-requests.json`（同 T4 pattern，文件 mode 0600）——验证：脱敏单元测试（含缺失头、短值边界、落盘文件无原文）+ 环形覆盖测试（201 条后恒 200）
- [ ] T9 proxy.js 请求完成处埋点 + `GET /api/recent-requests`（读落盘文件，缺失返回空数组）+ 设置页"最近请求"表（点击展开脱敏详情）；渲染函数遵守 ≤800 行——验证：API 测试 + 页面节点断言

### 收尾
- [ ] T10 全量回归（`node --test --test-timeout=15000 "test/"*.test.mjs` 全部通过）+ CLAUDE.md 架构图补充新模块与 runtime/ 目录约定（快照文件 mode 0600、可整目录删除）——验证：全量测试 0 fail

## 验收标准
- [ ] 看板可导出近 30 天 CSV 与 JSON，行数与数值与 /api/usage 一致；未知 format 返回 400
- [ ] 用量达 80% 显示黄色预警、达 100% 显示红色超限（比值基准为已配置预算项的最大比值），阈值可在 config.json 配置且非法配置回退默认
- [ ] 设置页可见当前活跃上游、各上游成功率/TTFT p50/p95、最近故障转移时间与原因（数据来自 proxy 落盘共享文件），且代理运行期间未向上游发出任何探活请求
- [ ] node:sqlite 可用环境用量写入 SQLite（WAL，含小时粒度），不可用环境自动回退 JSON，两模式看板数据一致（注入桩对照验证）；历史 usage.json 导入后保留 `.imported` 备份，导入失败原文件保留并回退 JSON
- [ ] 最近请求视图仅含元数据，任何密钥头均不出现原文（仅末 4 位，内存与落盘文件均如此），环形缓冲不超过 200 条
- [ ] 现有全部测试保持通过，新增功能均有对应测试
