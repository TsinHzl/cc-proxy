## 上下文

用量展示缩放（`usageScale`）目前以单一全局比例 `ratio` 缩放上游返回的 usage input 类字段（
控制 Ctx% 显示与 auto-compact 触发时机），`baseUrls` 定向列表只能决定「哪些上游缩放」，
无法让不同上游使用不同比例。`effortOverride` 已实现条目级独立档位（`{ url, level }` 形态，
混合形态 + 最长路径前缀仲裁 + 规范串去重），由 `src/base-url-match.js` 的条目形态原语
`buildBaseUrlTargetEntries` / `resolveBaseUrlTargetValue`（三态）支撑。本变更让 usageScale
与 effortOverride 对齐：`baseUrls` 条目各自携带独立 `ratio`。

## 目标 / 非目标

目标：
- `usageScale.baseUrls` 条目支持混合形态（字符串 = 继承全局 ratio；`{ url, ratio }` = 独立比例）。
- 复用既有条目形态匹配原语，从结构上保证与 effortOverride 定向语义不可能分歧。
- 设置页 usageScale 列表每行比例输入框，effort 列表档位下拉不受影响。

非目标：
- 不改变 `ratio` 值域与缩放算法；不改 effortOverride 行为；不引入外部依赖。

## 决策

### D1：全局 ratio 兜底 + 条目级覆写（state model）

沿用 effort 的「全局值兜底 + 每项可覆写」模型。条目未指定比例 → 继承全局 `ratio`；
指定 → 用自己的 `ratio`。三态自一致：

| 请求命中 | 生效比例 |
|---|---|
| 无列表（entries null） | 全局 ratio（全量缩放） |
| 命中条目且带 ratio | 该条目 ratio |
| 命中条目未指定 | 全局 ratio（条目 value 为 null） |
| 未命中 | `null`（1:1 透传） |

### D2：复用既有条目形态原语

不新增匹配代码。`buildBaseUrlTargetEntries` 把 `ratio` 作为条目 `value`，
`resolveBaseUrlTargetValue` 返回三态。`scaleTargetSet`（Set 形态）替换为
`scaleTargetEntries`（条目形态）。既有 `isBaseUrlTargetHit` 在条目实现上遍历，
usageScale 定向语义逐字节不变。

### D3：请求级生效比例单一决议点

proxy 维持全局 `usageScaleRatio` 不变（兜底），新增请求级 `effectiveScaleRatio`：
仅在两处类调用点（流式写事件、非流式 JSON）之前一次性决议。流式与非流式
共用同一决议值，不可能出现两条路径比例不一致。`scaleUsageInEvent` /
`scaleUsageInMessageJson` 签名不变（仍按单 ratio 缩放），内部改动仅限调用点。

### D4：配置归一与 API 校验对齐 effort

- `src/settings.js`：新增 `cleanScaleTargets`，与 `cleanEffortTargets` 完全同构——
  字符串保留；`{ url, ratio }` 且 `ratio` 有限数 ∈ (0,10] 保留；`{ url }` 或缺省/非法
  ratio 归一为字符串；非法项逐项丢弃；规范串去重保留首项。
- `bin/settings-web.js`：新增 `isValidScaleTargetArray`（字符串项 isHttpUrl；对象项
  url 合法 + ratio 存在时有限数 ∈ (0,10]）+ 边界归一（对象项只保留 url/ratio 两键）。

### D5：设置页工厂数值输入框

`bin/settings-page-targetlist.js` 列表描述新增比例输入框声明，工厂按声明渲染数字
`<input type="number">`。空 = 继承全局（提交纯字符串）；非空校验为有限数 (0,10] 才
提交 `{ url, ratio }`。effort 列表不声明该控件，行为不变。「无变化」判定沿用
序列化比较（数组含对象后 === 逐项比较失效）。

## 风险 / 权衡

| 风险 | 权衡 |
|---|---|
| `type="number"` 的 step/精度 | 用 `inputmode="decimal"` + 本地有限数校验；服务端与配置层二次校验兜底 |
| 旧 config 迁移 | `cleanScaleTargets` 对 string 项原样保留 → 零迁移 |
| 条目级与全局语义混淆 | UI 明确「留空 = 继承全局」，与 effort「继承全局」下拉选项对齐 |
| 数组含对象后 PATCH 无变化比较 | 已改用序列化比较（effort 已采用） |

## 迁移方案

旧 `usageScale.baseUrls` 为纯字符串数组，读入后逐项仍为字符串 → 全部继承全局 ratio，
与现状逐字节一致。无迁移动作。

## 待决问题

无。比例值域 (0,10] 与 UI 形态已由用户在阶段 0 确认（数字输入框；混合形态对齐 effort）。