# 任务清单：multi-upstream-failover

## 状态：ARCHIVED

## 任务
- [x] 任务 1：settings.js 新增 `upstreams` 配置项——DEFAULT_CONFIG 补 `upstreams: []`，normalizeConfig 校验每项（baseUrl 非空字符串；name 缺省取 host；headers 须为字符串键值对象否则丢弃该字段；非法项丢弃），`writeConfig` 顶层合并纳入 `upstreams` 键，验证：单测覆盖合法/缺名/非法项/非数组回退 + writeConfig 写盘后 upstreams 保留
- [x] 任务 2：upstream.js 转发层支持 target 列表——`forwardRequestWithRetry` 接受 targets 数组（首项主上游，每项含 target + 可选 headers），内层同上游 3 次重试不变，重试耗尽（连接错误或 `FAILOVER_STATUS = {429, 500, 502, 503, 529}`）后切下一上游并合并该项 headers；`isClientGone` 时终止；未配置时单元素数组行为逐字节不变
- [x] 任务 3：proxy.js / claude-proxy.js 集成——请求侧把主上游 + settings.upstreams（启动时读取一次并固定）解析为 targets 列表传入转发层；CLI 启动横幅在有备用上游时追加一行 failover 列表（logger.warn）；切换事件打印一条 warn（失败渠道名 + 切换目标），验证：cli/proxy 集成单测
- [x] 任务 4：新增 failover 单元测试（备用上游解析、触发与顺序、headers 合并、全部失败返回最后错误、未配置时零行为变化）+ 全量回归 `node --test --test-timeout=15000 "test/"*.test.mjs`，验证：全部测试通过
- [x] 任务 5：README.md / README.en.md 补「多上游故障转移」说明段（配置示例 + 行为语义），验证：人工核对文档与实现一致

## 验收标准
- [ ] 未配置 `upstreams` 时所有请求行为与现状完全一致（既有测试全绿）
- [ ] 主上游重试耗尽后自动切换到备用上游，SSE/非流式响应均正常
- [ ] 全部上游失败时客户端收到最后一个错误响应（不挂起、不崩溃）
- [ ] 启动横幅与切换事件日志按 CC_PROXY_LOG=1 可见，默认静默不变
