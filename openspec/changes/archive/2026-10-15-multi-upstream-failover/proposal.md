# 变更提案：multi-upstream-failover

## 背景

cc-proxy 当前只支持单一上游（启动时的 `ANTHROPIC_BASE_URL`，默认官方 API）。同一上游内重试（`forwardRequestWithRetry`）只对同一上游重试 3 次，遇到第三方网关长时间故障（限流、宕机、欠费）时整个会话不可用。用户通常拥有多个可用渠道（官方 + 多个第三方网关），希望主渠道故障时自动切换到备用渠道，会话不中断。

## 目标范围

**在范围内：**
1. `src/settings.js` 扩展：新增 `upstreams` 配置项——可选的备用上游数组，每项形如 `{"name": "gw2", "baseUrl": "https://gw2.example.com", "headers": {"x-api-key": "sk-..."}}`；`headers` 可选，用于备用渠道差异化鉴权；空/缺省时行为与现状完全一致（单上游）
2. `src/upstream.js` 扩展：新增故障转移逻辑——主上游重试耗尽仍失败（连接错误 / `FAILOVER_STATUS = {429, 500, 502, 503, 529}`，独立于同上游重试用的 `RETRYABLE_STATUS`，覆盖限流与宕机场景）时，依次尝试 `upstreams` 列表中的备用上游，每个上游同样享受 3 次内部重试，切换时合并该项 `headers`（若配置）到请求头；全部失败后返回最后一个错误响应
3. `src/proxy.js` 集成：请求进入时把主上游与备用上游一并解析为 target 列表传入转发层；备用上游与主上游共用同一请求路径拼接规则（`resolveUpstream` 语义）
4. CLI 启动横幅：配置了备用上游时打印一行提示（如 `[claude-proxy] failover upstreams: gw2 (https://gw2.example.com), ...`），走 logger.warn（CC_PROXY_LOG=1 可见）；`upstreams` 在 CLI 启动时读取一次并固定（不热加载）
5. 切换事件日志：每次实际发生上游切换时打印一条 `logger.warn`（含失败渠道名与切换目标），不落盘
6. 单元测试：备用上游解析、failover 触发与顺序、全部失败回退、未配置时零行为变化

**不在范围内：**
- 健康检查/主动探测、自动故障恢复回切（会话内一旦切换，后续请求继续用当前渠道）
- 按渠道的 usage 统计分组、费用差异展示
- 配置热加载（仍为启动时读取一次，与现有 forwardSuggestionMode 语义一致）
- 负载均衡/加权轮询（纯故障切换，无流量分配）
- 应用层请求超时（上游接受连接但不响应的场景依赖客户端/OS 层行为兜底，不在本期）

## 技术方案

- 配置：`DEFAULT_CONFIG.upstreams = []`；`normalizeConfig` 校验每项为含非空 `baseUrl` 字符串的对象，`name` 缺省时取 host，`headers` 须为字符串键值对象（否则丢弃该字段），非法项直接丢弃（与 models 校验同风格）；**`writeConfig` 顶层合并同步纳入 `upstreams` 键**，防止下次写盘时被静默丢弃
- 转发层：`forwardRequestWithRetry(req, body, targets[], respond, onError)`——`targets` 为有序数组（首项为主上游，每项含 target + 可选 headers）；现有单 target 调用点包一层数组即可保持兼容；内层重试逻辑不变，外层在 `targets[i]` 重试耗尽后切 `targets[i+1]`
- 切换判定：连接错误或响应状态码命中 `FAILOVER_STATUS`；客户端已断开（`isClientGone`）时终止切换
- 请求侧改写（history strip / effort / system prompt / Suggestion Mode 拦截）发生在转发之前，与上游选择无关，零接触
- usage / debug-log 挂接点在 respond 回调内，不感知上游个数，零改动

## 预期影响

- 未配置 `upstreams` 时所有路径行为与现状逐字节一致（含重试时序）
- 备用上游仅在主上游重试耗尽后才收到流量；切换发生在响应头写出之前，对客户端透明
- SSE 流一旦开始转发即不再切换（与现有"headers 已提交不重试"语义一致）
- 不触碰 thinking 转换管线、设置页、usage 结构
- 适用边界：备用渠道需通过 `headers` 自行提供其鉴权头（如独立 x-api-key）；未配置 headers 的备用上游沿用请求原鉴权头，仅适用于同 key 多域名或免鉴权网关

## 风险

- 备用上游路径拼接差异 → 复用 `resolveUpstream` 的既有语义（base 路径前缀原样拼接），与主上游一致
- 切换引入额外延迟 → 仅在故障场景发生，正常流量零开销
- `headers` 配置含敏感 key → 仅存在于用户本地 config.json（0600 权限），代理日志不打印 header 值（与 debug-log 既有约定一致）
