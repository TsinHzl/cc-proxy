# 变更提案：usage-dashboard-and-cache-stats

## 背景

cc-proxy 已按天累计 token 用量到 `~/.cc-proxy/usage.json`（src/usage.js），但数据只有一个总数形态，用户无法在界面上看到趋势与构成；且未按模型分组、未利用已有的 cacheReadTokens/cacheCreationTokens 字段计算 prompt 缓存命中率（命中率直接反映 Claude Code 会话的成本效率）。本变更把已有数据可视化，并补充按模型统计维度与缓存命中率，同时在 CLI 启动时对超阈值用量给出提示。

## 目标范围

**在范围内：**
1. `src/usage.js` 扩展：usage.json 按天数据结构增加按模型分组（`byModel: { [model]: EMPTY_USAGE 形状 }`）；旧格式（无 byModel）向后兼容读取
2. 缓存命中率计算：`hitRate = cacheReadTokens / (inputTokens + cacheReadTokens + cacheCreationTokens)`，无分母时为 null
3. 新增 `src/pricing.js`：内置常见 Claude 模型默认单价表（input/output/cache_read/cache_creation，USD per MTok），config.json `models.<model>.pricing` 可覆盖；未收录模型费用为 null（只显示 token）
4. `src/settings.js` 扩展：DEFAULT_CONFIG 与 normalizeConfig 白名单纳入 `alerts.dailyTokens`（非数字回退默认）与 `models.<model>.pricing`（非对象回退默认）
5. 日阈值告警：config.json `alerts.dailyTokens`（可选数字）；超限后 CLI 启动横幅打印一条警告 + 设置页看板顶部红点提示。阈值口径为四类 token 总和（input+output+cacheRead+cacheCreation）
5. 设置页新增用量看板：近 7 天每日 token 柱状图（纯 HTML/CSS，无外部库）、请求次数、按模型分组表、缓存命中率、估算费用
6. CLI 退出总结（已有）补充缓存命中率（命中率为 null 时显示 `n/a`）

**不在范围内：**
- 推送/邮件/系统通知等外部告警渠道
- 费用的历史趋势图（只按当前价表估算当日与近 7 天）
- 多用户/远程访问（设置页仍仅 127.0.0.1）
- usage.json 数据迁移工具（旧格式兼容读取即可）

## 技术方案

- 数据结构：`usage.json` 每天条目从 `{requests, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens}` 扩展为追加 `byModel`；`normalizeDay` 对缺省 byModel 回退 `{}`，`record` 同时累计总字段与模型字段（model 取自 message_start 的 `message.model`，缺失归入 `unknown`）
- 定价：`src/pricing.js` 导出 `estimateCost(dayUsage, modelPricingOverrides)`；内置价表为常量对象（如 `claude-sonnet-4-5` 等），匹配规则为模型名前缀匹配；费用 = Σ(input×p_in + output×p_out + cacheRead×p_cr + cacheCreation×p_cc)
- 告警检查为读取时计算（summary/view 时比较阈值），不落盘状态
- 设置页：`GET /api/usage` 返回近 7 天数组（含 byModel、hitRate、cost），页面用内联脚本渲染柱状图与表格；遵守现有 Host/Origin/nonce/token 认证链，无新认证面
- CLI：`bin/claude-proxy.js` 启动时读 summary 与阈值比较，超限经现有 stderr 横幅渠道打印（CC_PROXY_LOG 语义之外的一次性用户可见提示，与退出总结同类）

## 预期影响

- usage.json 新增 byModel 字段：旧文件正常读取（缺失按空处理），旧版本 cc-proxy 读新文件时忽略未知字段，无破坏
- 每次请求的落盘成本不变（仍为单次读写）
- 非 CC 流量、thinking 转换管线零接触，不影响任何现有不变量
- 设置页新增一个只读 API 端点，认证链复用现有机制

## 风险

- 内置价表会过时 → 可通过 config 覆盖，且未收录模型只显示 token，不显示错误费用
- 按天读写 usage.json 与模型分组累计并发写竞争 → 沿用现有同步单进程写模型（cc-proxy 单进程），无新增风险
- 设置页图表 XSS → 所有动态内容（含 byModel 模型名字符串）一律 textContent/数字格式化渲染，不拼接 HTML
