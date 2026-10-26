## Purpose
用量展示缩放：按配置比例缩放返回给 Claude Code 的 usage input 类字段（控制 Ctx% 显示与 auto-compact 触发时机），支持全局比例兜底 + 每条目独立比例覆写，内部统计始终记录上游真实值。

## MODIFIED Requirements

### Requirement: 用量展示缩放按比例改写 usage 字段
The system SHALL 在 `usageScale.enabled=true` 时按配置比例缩放返回给 Claude Code 的 usage **input 类字段**（`input_tokens`、`cache_creation_input_tokens`、`cache_read_input_tokens` 及 `cache_creation` 嵌套的 `ephemeral_*`，向上取整），`output_tokens` 不缩放；内部用量统计（`usage.json`）与设置看板始终记录上游真实值。`ratio` 为有限数 (0,10]，缺省 1.0（等效不缩放）；非 CC 客户端、错误响应与非 message JSON 一律原样透传。`baseUrls` 支持定向：非空列表时仅当实际命中上游的完整 base URL 匹配条目时缩放；条目为混合形态——纯字符串继承全局 `ratio`，对象 `{ url, ratio }` 使用该条目自己的比例；多条同时命中时路径更长（更具体）的条目录生效，同一 URL 规范串去重保留首项。配置在代理启动时读取一次，切换后需下次会话生效。

#### Scenario: 全局比例缩放
- **GIVEN** `usageScale.enabled=true`、`ratio=0.5`、`baseUrls=[]`
- **WHEN** 上游返回 usage `input_tokens=5`（非 0）
- **THEN** 返回给 CC 的 `input_tokens` 为 `ceil(5×0.5)=3`，`output_tokens` 不缩放

#### Scenario: 条目独立比例覆写
- **GIVEN** `baseUrls=["https://a.com", {"url":"https://b.com/api","ratio":0.5}]`，全局 `ratio=1`
- **WHEN** 请求命中上游 `b.com/api`
- **THEN** 按 `0.5` 缩放该上游返回的 input 类字段，其余上游按全局 `1`（不缩放）

#### Scenario: 字符串条目继承全局
- **GIVEN** 全局 `ratio=0.5`，`baseUrls=["https://a.com"]`
- **WHEN** 请求命中 `a.com`
- **THEN** 按全局 `0.5` 缩放

#### Scenario: 最长路径前缀优先
- **GIVEN** `baseUrls=["https://a.com", {"url":"https://a.com/api","ratio":0.2"}]`
- **WHEN** 请求命中 `a.com/api`
- **THEN** 以 `/api` 条目的 `0.2` 缩放，而非 `a.com` 条目的值

#### Scenario: 未命中的上游 1:1 透传
- **GIVEN** `baseUrls=["https://a.com"]`
- **WHEN** 请求命中未配置的 `b.com`
- **THEN** usage 字段不缩放（等效关闭态）

#### Scenario: 旧纯字符串配置零迁移
- **GIVEN** `baseUrls=["https://a.com"]`（纯字符串数组）
- **WHEN** 读取配置
- **THEN** 全部条目继承全局 `ratio`，与既有行为一致

#### Scenario: 配置容错
- **GIVEN** `baseUrls` 含对象 `{"url":"https://a.com"}`（缺 ratio）与非法项
- **WHEN** 读取配置
- **THEN** 缺 ratio 的对象归一为字符串（继承全局），非法项逐项丢弃；全部非法时列表退化为空 → 等效全量缩放