# Delta Spec：observability-and-storage-hardening

## Purpose
为 cc-proxy 增加可观测性与数据层能力：用量数据可导出、告警分级可配置；上游健康状况被动可视；用量存储支持 SQLite（含小时粒度）并兼容回退 JSON；请求级元数据调试视图（脱敏）。覆盖四个关联行为面：usage-export-alerting、upstream-health、usage-storage、request-debug-view。

## ADDED Requirements

### Requirement: 用量数据导出
The system SHALL 提供用量导出接口，支持 CSV 与 JSON 两种格式，导出内容为近 30 天聚合明细（日期、请求数、各类 token、估算费用），与看板展示数据同源一致。

#### Scenario: 导出 CSV
- **GIVEN** 代理已积累至少一天用量数据
- **WHEN** 请求 `GET /api/usage/export?format=csv`
- **THEN** 响应 Content-Type 为 `text/csv`，首行为表头（date,requests,inputTokens,outputTokens,cacheReadTokens,cacheCreationTokens,cost），每行对应一天
- **AND** 行数据与 `/api/usage` 同日数据一致

#### Scenario: 导出 JSON
- **WHEN** 请求 `GET /api/usage/export?format=json`
- **THEN** 响应 Content-Type 为 `application/json`，数据结构与 `/api/usage` 一致

#### Scenario: 未知格式
- **WHEN** format 参数缺失或非 csv/json
- **THEN** 返回 400 错误

### Requirement: 分级用量告警
The system SHALL 按「今日用量相对预算的比值」提供两级告警：比值取 max(今日 tokens / alerts.dailyTokens, 今日估算费用 / alerts.dailyCost)（仅计算已配置项，均未配置时 level 为 none）；比值达到预警阈值（默认 0.8）时返回 warn 级，达到上限阈值（默认 1.0）时返回 limit 级；两个阈值 SHALL 可在 config.json 中配置，且 warn 阈值 MUST 小于 limit 阈值，两个阈值 MUST 不大于 1（比值语义上限）。

#### Scenario: 预警级
- **GIVEN** alerts.dailyCost 预算为 10，今日估算费用为 8.5，warnThreshold 为 0.8
- **WHEN** 计算告警
- **THEN** 返回 level 为 `warn`

#### Scenario: 超限级
- **GIVEN** 今日估算费用为 10.5（相对同一预算比值 > 1.0）
- **WHEN** 计算告警
- **THEN** 返回 level 为 `limit`

#### Scenario: 无预算配置
- **GIVEN** config.json 中 alerts.dailyTokens 与 alerts.dailyCost 均未配置
- **WHEN** 计算告警
- **THEN** 返回 level 为 `none`，不抛出错误

#### Scenario: 非法阈值配置
- **GIVEN** config.json 中 warnThreshold ≥ limitThreshold 或为非法数值
- **WHEN** 读取配置
- **THEN** 回退默认值 0.8 / 1.0，不抛出错误

### Requirement: 上游健康被动统计
The system SHALL 基于真实代理请求被动记录每个上游的成功/失败次数与 TTFT，并提供健康快照（各上游请求次数、成功率、TTFT p50/p95、当前活跃上游、最近一次故障转移时间与原因）；系统 MUST NOT 为健康统计发起任何主动探测请求。

#### Scenario: 查看健康快照
- **GIVEN** 代理已转发若干请求且发生一次主上游失败切换
- **WHEN** 请求 `GET /api/upstream-health`
- **THEN** 响应含各上游的 requests/successRate/ttftP50/ttftP95、当前活跃上游标识、最近切换事件（时间与原因）

#### Scenario: 无请求时
- **WHEN** 尚无任何请求记录
- **THEN** 快照各上游计数为 0，successRate 为 null，不抛出错误

#### Scenario: 设置页进程读取
- **GIVEN** proxy 进程已将健康快照落盘到共享文件，settings-web 为独立进程
- **WHEN** 请求 `GET /api/upstream-health`
- **THEN** settings-web 从落盘快照读取并返回（数据可滞后写盘间隔），不依赖与 proxy 的进程内通信

### Requirement: 用量存储 SQLite 优先与 JSON 回退
The system SHALL 在 `node:sqlite` 可用的运行时将用量数据写入 SQLite（按天聚合 + 按小时聚合，启用 WAL 模式），否则 SHALL 自动回退到现有 JSON 文件模式且行为保持一致；首次切换到 SQLite 时 SHALL 将既有 usage.json 数据在单事务内导入（导入在请求转发开始前完成），导入成功后将原文件重命名为 usage.json.imported 保留备份，导入失败 MUST 回滚并保留原文件继续 JSON 模式；SQLite 可用性探测 SHALL 基于动态 import 与特性检测（不依赖版本号），且 SHALL 支持测试注入探测结果。

#### Scenario: SQLite 可用
- **GIVEN** 运行时支持 node:sqlite
- **WHEN** 代理记录用量
- **THEN** 数据写入 SQLite 的按天与按小时聚合表，/api/usage 返回数据与 JSON 模式同结构

#### Scenario: SQLite 不可用
- **GIVEN** 运行时不支持 node:sqlite（如 Node 18/20）
- **WHEN** 代理启动
- **THEN** 静默回退 JSON 模式，全部用量功能行为不变

#### Scenario: 历史数据导入失败
- **GIVEN** 既有 usage.json 存在但导入事务失败
- **WHEN** 代理启动
- **THEN** 回滚导入、原文件保留原名、本次运行使用 JSON 模式

### Requirement: 请求级调试视图（脱敏）
The system SHALL 在内存环形缓冲区（最多 200 条）记录每个已完成请求的元数据（时间、模型、上游、状态码、TTFT、是否 thinking 改写、是否发生故障转移），并提供查询接口；请求与响应头摘要中，认证类头（Authorization、x-api-key 等）的值 MUST 在写入缓冲前脱敏为仅保留末 4 位，原始值 MUST NOT 被存储；请求与响应体内容 MUST NOT 被记录。

#### Scenario: 查看最近请求
- **GIVEN** 代理已处理若干请求
- **WHEN** 请求 `GET /api/recent-requests`
- **THEN** 响应按时间倒序返回缓冲区内元数据条目，最多 200 条

#### Scenario: 头部脱敏
- **GIVEN** 请求头含 `Authorization: Bearer sk-ant-1234567890`
- **WHEN** 该请求被记录
- **THEN** 缓冲中的 Authorization 值仅显示 `***7890` 形式的脱敏值，无原文

#### Scenario: 环形覆盖
- **GIVEN** 缓冲已满 200 条且新请求持续到达
- **WHEN** 新请求完成
- **THEN** 最旧条目被移除，缓冲长度恒不超过 200
