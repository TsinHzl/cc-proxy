# 任务清单：usage-scale-per-baseurl-ratio

## 状态：ARCHIVED

## 任务

- [x] T1 基线核对与需求澄清：确认 usageScale 现状（全局 ratio + Set 定向）、effortOverride 条目形态已就绪、断言「数组含对象后设置页无变化比较须改序列化」等既有边界，为实现建立准确基线；验证：proposal 目标范围与实际代码一致（读 proxy.js / settings.js / usage-scale.js / base-url-match.js）。
- [x] T2 `src/base-url-match.js` 核验共享原语：确认 `buildBaseUrlTargetEntries` / `resolveBaseUrlTargetValue` 的三态契约（undefined / null / 值）可被 usageScale 直接复用为「未命中 / 命中未指定回退全局 / 独立比例」，并补充 usageScale 侧单元测试锁定该复用语义；验证：`node --test --test-name-pattern="entries|resolve" test/base-url-match.test.mjs` 新增用例通过。
- [x] T3 `src/settings.js` 新增 `cleanScaleTargets`（混合形态 + 规范串去重，字符串 / `{url,ratio}` 合法保留、`{url}` 或缺省/非法 ratio 归一为字符串、仅 url 非法或非字符串非对象项丢弃），`usageScale.baseUrls` 改走该函数并废弃对 `cleanBaseUrls` 的引用；验证：settings 归一单测（混合合法 / 对象缺 ratio 归一 / 非法丢弃 / 全部非法退化为空 / 跨形态去重（`"https://a"` 与 `{url:"https://a/"}` 判重复保留首项）/ 旧 string[] 等价）。
- [x] T4 `src/proxy.js` 把 `scaleTargetSet`（Set 形态）改为 `scaleTargetEntries`（条目形态），`usageScale.enabled===true` 时按 `baseUrls` 构造（`buildBaseUrlTargetEntries` 空/全非法返回 null），请求级生效比例三态解析（全量 → 全局 / 命中带 ratio → 条目 ratio / 命中未指定 → 回退全局 / 未命中 → 1:1）；流式与非流式两条缩放调用点改传请求级 `effectiveScaleRatio`，既有 `scaleUsageInEvent` / `scaleUsageInMessageJson` 签名不变；同步更新 `src/usage-scale.js` 末尾引用 Set 形态原语的陈旧注释；验证：proxy-usage-scale 定向用例（命中独立比例 / 命中继承全局 / 未命中 1:1 / 空列表全量 / failover 各候选独立判定 / 非对象 body 不崩溃）。
- [x] T5 `bin/settings-web.js` 新增 `isValidScaleTargetArray`（字符串项 isHttpUrl；对象项 url 合法 + ratio 存在时 ∈ (0,10] 有限数）与 PATCH 边界归一（对象项只保留 url/ratio 两键、丢弃缺省 undefined 键）；`usageScale.baseUrls` 校验与归一改走新函数；验证：settings-web 测试新增 PATCH 混合数组合法 + 非法 400（非对象 / url 非法 / ratio 越界 / ratio 非数 / ratio 0 / ratio 负数）。
- [x] T6 `bin/settings-page-targetlist.js` 列表描述新增数值比例输入框声明，工厂按声明渲染数字 `<input>`（空 = 继承全局，非空提交 `{url, ratio}`，前端本地校验 (0,10] 有限数），usageScale 列表启用、effort 列表不受影响（保持档位下拉）；「无变化」判定沿用序列化比较；验证：页面测试新增比例输入框渲染、对象回填、effort 无比例框、本地非法回滚。
- [x] T7 全量回归 + README 同步：`npm test`（或 `node --test --test-timeout=15000 "test/"*.test.mjs`）全绿；更新 README.md / README.en.md 的「用量展示缩放」小节（每条目独立比例、混合形态、UI 说明）与目录结构不改；验证：全量测试通过 + 两版 README 标题层级一一对应。

## 验收标准

- [ ] `usageScale.baseUrls` 支持混合形态：纯字符串继承全局 ratio；`{ url, ratio }` 独立比例；同一数组可混用。
- [ ] 旧 `string[]` 配置零迁移，语义 = 「全部继承全局比例」。
- [ ] 多命中仲裁、URL 去重、failover 逐候选判定与 effort 完全一致（共享原语）。
- [ ] 设置页 usageScale 列表每行比例输入框可用，effort 列表档位下拉不受影响。
- [ ] 配置容错与 API 校验覆盖非法比例（settings 归一、API 400、页面本地拦截）。
- [ ] 全量测试通过（含新增 proxy / settings / settings-web / targetlist 用例）。