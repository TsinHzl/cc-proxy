# 变更提案：usage-scale-baseurl-targeting

## 背景

usage 展示缩放（2026-10-19 已归档 usage-display-scale）当前为全局开关：`usageScale.enabled=true` 时对所有 CC 客户端可见响应的 usage input 类字段统一按 ratio 缩放。用户亲测可用后提出定向需求：多上游场景（主上游 + 备用上游 / 官方 + 中转）下，只想对特定上游（如某中转网关）的响应缩放，官方 API 维持真实值。

## 目标范围

**在范围内：**
- `usageScale` 新增 `baseUrls: string[]` 配置（默认 `[]`）
- 匹配语义（完整 base URL 匹配）：
  - 列表为空 + enabled=true → 维持现行为：全部上游响应缩放
  - 列表非空 + enabled=true → 仅当实际命中上游的完整 base（协议 + host + 端口 + base 路径）命中列表任一项时缩放，其余上游 1:1 透传
  - 命中判定：origin（协议+host+显式/缺省端口归一）相等且路径为段前缀（配置路径为空 = 该 origin 全部路径；`/api` 命中 `/api` 与 `/api/x`，不命中 `/apiv2`）；尾斜杠归一
  - enabled=false → 与列表无关，全部 1:1 透传（现行为）
- 故障转移兼容：缩放判定基于「本请求实际响应的上游」（failover 后按新上游判定），跟随 onFailover 更新
- 设置页：用量展示缩放区块下新增「目标上游」动态列表（行增删 + 行内编辑），操作/blur 时全量提交数组；本地拦截非法 URL（提示不提交）
- 设置 API：`usageScale.baseUrls` 加入 ALLOWED_KEYS；值须为字符串数组且逐项可 `new URL` 解析且协议为 http/https，否则 400
- 配置容错：normalizeConfig 对 baseUrls 逐项校验，非法项丢弃（与 upstreams 风格一致）；写盘合并保留
- 文档：README 配置示例与说明更新（含边界：baseUrls 全部非法被逐项丢弃后等效空列表，退化为全量缩放）

**不在范围内：**
- 每 URL 独立 ratio（维持单一全局 ratio）
- 热切换（配置重启会话后生效，与既有 usageScale 行为一致）
- 非 CC UA 流量的任何改写（维持原样透传）
- 内部统计口径变化（始终真实值）

## 技术方案

1. **匹配原语（src/usage-scale.js）**：新增 `normalizeScaleBaseUrl(raw)`（`new URL` 解析 → `protocol//hostname:归一port + 去尾斜杠路径`，空路径归一为 `''`）、`buildScaleTargetSet(baseUrls)`（规范化成功项入 Set；输入空/全非法 → null 表示「空列表=全量缩放」语义）与 `isScaleTargetHit(normalizedBase, targetSet)`（origin 相等 + 路径段前缀，配置路径为空覆盖该 origin 全路径）。
2. **命中上游跟踪（src/proxy.js）**：主上游 base 以 `resolveUpstream('', baseUrlEnv)` 结果构造规范化串；备用上游在 failoverBases 既有 base/basePath 上构造。buildTargets 产出的每个 entry 附加 `base` 字段（规范化串）。请求级新增 `activeUpstreamBase`（初始主上游 base），`onFailover` 回调从新增第 4 参数 `toEntry.base` 更新——消除 label（name||host）不含路径的信息丢失。
3. **缩放判定时机**：respond 回调内（此时 failover 已终结、activeUpstreamBase 即实际命中上游）每请求计算一次 `effectiveScaleRatio = (usageScaleRatio !== null && (targetSet === null || isScaleTargetHit(activeUpstreamBase, targetSet))) ? usageScaleRatio : null`；SSE 循环与非流式 transform 改用该值。内部统计、debug 日志不变。
4. **upstream.js 最小侵入**：`onFailover(from, to, reason, toEntry)` 追加第 4 参数（向后兼容，既有 3 参数调用与测试不受影响）。
5. **配置与 API**：settings.js DEFAULT_CONFIG.usageScale 增 `baseUrls: []`；normalizeConfig 逐项校验丢弃（字符串 + `new URL` 可解析 + http/https 协议，否则丢该项）；writeConfig 浅合并沿用（数组整体替换）。settings-web.js ALLOWED_KEYS 增 key，isValidSettingsPatch 增数组校验分支（与 normalizeConfig 同口径）。
6. **设置页拆分（行数约束）**：bin/settings-page.js 已 766 行（上限 800），新增列表 UI/脚本约 +90 行将超限。新建 `bin/settings-page-scaletargets.js` 导出 HTML 片段与脚本片段，settings-page.js 导入拼接，两文件各自 <800 行。
7. **测试**：usage-scale 规范化/匹配单元测试；settings normalize（默认/非法丢弃/合并保留）；settings-web PATCH（合法/非法 400/非数组 400）；proxy 集成（主命中缩放、主不命中透传、failover 后备用命中缩放、failover 后不命中透传、空列表全缩放）。

## 预期影响

- 未配置 baseUrls（默认 []）时行为与现版本一致（targetSet 为 null 短路，零语义变化）
- baseUrls 非空时未命中上游恢复 1:1 透传，CC 端 Ctx%/auto-compact 对这些上游回到真实值
- onFailover 签名追加参数对现有唯一调用方（proxy.js）与既有测试无破坏
- 设置页新增一个可交互列表区块，无既有控件行为变化

## 风险

- **匹配语义歧义**：路径前缀按段比对（`/api` 不命中 `/apiv2`）已在提案固化；空路径配置（纯 origin）覆盖该 origin 全路径，文档显式说明
- **failover 中途切换**：判定基于最终响应上游（响应头到达时 failover 已定），无中间态泄漏
- **设置页行数**：以模块拆分约束在 800 行内；拆分仅模板拼接层，无逻辑分散
- **配置容错**：手改 config.json 出现非法项时逐项丢弃（不整体回退），与 upstreams 容错一致；设置页读回后仅显示有效项
