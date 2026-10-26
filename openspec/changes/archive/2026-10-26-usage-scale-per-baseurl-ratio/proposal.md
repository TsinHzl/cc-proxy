# 变更提案：usage-scale-per-baseurl-ratio

## 背景

`usageScale`（用量展示缩放）目前只支持**单一全局比例** `ratio`，配合 `baseUrls` 定向列表时，
所有命中上游共用同一个 `ratio`。而 `effortOverride` 已支持 `baseUrls` 条目独立携带自己的档位
（`{ url, level }` 形态）。用户希望 `usageScale` 与 `effortOverride` 对齐：**每个目标上游
可单独配置自己的缩放比例**，而非共用全局 `ratio`。

现状对比：

| | effortOverride | usageScale |
|---|---|---|
| 全局值 | `level`（档位） | `ratio`（有限数 (0,10]） |
| baseUrls 定向 | ✅ 条目可带 `level` | ❌ 纯字符串，共用全局 ratio |
| 多命中仲裁 | 最长路径前缀优先 | （Set 形态，无条目） |

## 目标范围

**在范围内：**
- `usageScale.baseUrls` 条目支持混合形态：纯字符串（继承全局 `ratio`）与对象 `{ url, ratio }`
  （独立比例），同一数组可混用——与 `effortOverride.baseUrls` 完全对齐。
- 全局 `ratio` 降级为「条目未指定比例时的兜底」；旧纯字符串 `string[]` 配置读入即等价
  「全部继承全局比例」，零迁移成本。
- 多命中仲裁、去重、failover 语义、被动统计语义均与现有定向特性保持一致（共享
  `src/base-url-match.js` 条目形态实现）。
- 设置页「用量展示缩放」列表每行增加比例输入框（数字，空 = 继承全局）。
- 配置容错、API 校验与 README 同步更新。

**不在范围内：**
- 不改变 `ratio` 的值域约束（仍为有限数 (0,10]）与缩放算法（只缩放 input 类字段，output 不缩放）。
- 不修改 `effortOverride` 的任何行为。
- 不引入外部依赖。

## 技术方案

### 配置存储形态（与 effort 对齐）

```json
{
  "usageScale": {
    "enabled": true,
    "ratio": 0.8,
    "baseUrls": [
      "https://a.example.com",
      { "url": "https://gateway.example.com/api", "ratio": 0.5 }
    ]
  }
}
```

`baseUrls` 条目两形态，设置页保存时：未设置比例 → 纯字符串；设置比例 → `{ url, ratio }` 对象。

### 共享条目形态匹配（复用现有原语）

`src/base-url-match.js` 已有 `buildBaseUrlTargetEntries` / `resolveBaseUrlTargetValue`
（三态：`undefined` 未命中 / `null` 命中但条目未指定值 / 具体值）。usageScale 侧把 `ratio`
当作条目的 `value`，直接复用该实现，无需新增匹配逻辑——从结构上保证 usageScale 与
effortOverride 的定向命中语义不可能分歧。

### proxy 侧改造

`usageScaleRatio` 单一全局值保持不变（作为兜底；`normalizeConfig` 已保证其恒为合法值）。
新增：

- `scaleTargetEntries`（条目形态，替代 `scaleTargetSet` Set 形态），仅在
  `usageScale.enabled === true` 时按 `baseUrls` 构造——`buildBaseUrlTargetEntries` 自会对
  空列表 / 全非法返回 `null` → 等效空列表全量缩放，故全局 `ratio` 只做兜底、不作启用门。
- 请求级生效比例改为三态解析：
  - 未配置列表（entries 为 null）→ 全局 ratio（全量缩放）
  - 命中条目且条目带 `ratio` → `resolveBaseUrlTargetValue` 返回该 ratio
  - 命中条目但条目未指定 → 返回 `null` → 回退全局 ratio
  - 未命中 → 返回 `undefined` → `null`（1:1 透传，与关闭态同路径）

流式与非流式两条缩放调用点改传该「请求级生效比例」（`effectiveScaleRatio`），既有
`scaleUsageInEvent` / `scaleUsageInMessageJson` 签名不变（按单 ratio 缩放），只在调用点
解析出该请求的 ratio。

### 设置页工厂泛化

`bin/settings-page-targetlist.js` 目前每行可选控件为 `levels` select（effort 用）。为支持
usageScale 的数字比例输入框，列表描述新增数值输入框声名；工厂按声明渲染数字 `<input>`，
空值提交为纯字符串形态（inherit 全局），非空校验为有限数 (0,10]。usageScale 的
`cleanBaseUrls`（纯字符串）被 `cleanScaleTargets`（混合形态）取代，废弃对旧函数的引用。

## 预期影响

- **兼容**：旧 `string[]` 配置读入语义不变；`ratio` 缺省 1.0 恒等映射路径不变。
- **可维护性**：usageScale 与 effortOverride 共用条目形态匹配，定向语义单点维护。
- **页面**：usageScale 目标列表行新增比例输入框，effort 行保持档位下拉（互不影响）。

## 风险

| 风险 | 应对 |
|---|---|
| 条目 `ratio` 非法（非数 / 越界 / 非有限） | settings 逐项归一为字符串（继承全局）；API 判 400；页面本地校验第一道防线 |
| 比例输入框空值语义（继承 vs 越界） | 空 = 继承全局，与 effort「继承全局」下拉选项完全对齐，UI 明确注明 |
| 非流式 / 流式两条路径比值不一致 | 复用单一 `effectiveScaleRatio` 决议，一条调用路径（见 proxy 实现） |
| 数组含对象后既有 `===` 无变化比较失效 | settings-web 与 targetlist 均改序列化比较（effort 已采用，本项目沿用） |