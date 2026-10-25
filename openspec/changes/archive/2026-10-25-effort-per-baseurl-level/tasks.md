# 任务清单：effort-per-baseurl-level

## 状态：ARCHIVED

## 任务
- [x] T1 匹配模块扩展：src/base-url-match.js 抽出内部判定 `matchesTarget(base, normalizedTarget)`、新增 `buildBaseUrlTargetEntries(entries)`（按规范路径长度降序，无合法项 → null）与 `resolveBaseUrlTargetValue(base, entries)`（未命中返回 undefined）；`isBaseUrlTargetHit` 改为在该判定上遍历；test/base-url-match.test.mjs 补条目排序 / 最长前缀优先 / 未命中 undefined / usageScale 既有命中语义回归 — 验证：node --test test/base-url-match.test.mjs test/usage-scale.test.mjs
- [x] T2 配置层：src/settings.js 抽出 `cleanBaseUrl(value)` 供两处复用，新增 `cleanEffortTargets(input)`（字符串保留、`{url,level}` 合法保留、`{url}` 归一为字符串、非法逐项丢弃、按 `normalizeBaseUrl` 规范串去重保留首次档位），normalizeConfig 的 effortOverride.baseUrls 改用它（usageScale 口径不变）；test/settings.test.mjs 补四种归一分支 + 去重用例（含尾斜杠归一判重、字符串与对象混合重复）+ 旧 string[] 等价性 — 验证：node --test test/settings.test.mjs test/settings-cli.test.mjs
- [x] T3 设置 API：bin/settings-web.js 抽 `isHttpUrl(text)`、新增 `isValidEffortTargetArray(value)`（字符串走 isHttpUrl；对象须 url 合法且 level 存在时 ∈ EFFORT_LEVELS），effortOverride.baseUrls 改用它，`.baseUrls` 边界归一按 group 分流（effort 对象项只保留 url/level 两键）；test/settings-web.test.mjs 补混合数组合法 / 非数组 / 含非字符串非对象项 / 对象 url 非法 / 对象 level 非法 / level 缺失合法 六类 PATCH 用例 — 验证：node --test test/settings-web.test.mjs
- [x] T4 请求侧按条目档位：src/proxy.js 的 effortTargetSet 改为 effortTargets（buildBaseUrlTargetEntries，value 取 level），overrideBody 单变量改为按档位惰性记忆化 `bodyForLevel(level)`（未命中返回 null → 用 baseBody），保留 baseBody 定格时机与「未配置列表 = 全量覆写全局档位」；test/proxy-effort.test.mjs 补逐条目档位 / 最长前缀仲裁 / 条目继承全局（含 `{url}` 归一）/ 未命中不覆写 / 同请求两种档位体隔离 — 验证：node --test test/proxy-effort.test.mjs test/upstream-failover.test.mjs
- [x] T5 设置页列表工厂：bin/settings-page-targetlist.js 列表描述新增可选 `levels`（EFFORT 填 6 档 + 「继承全局」空值项），HTML 渲染行内档位 select、脚本 addRow/currentValues/render/syncControls 支持档位、change 触发 submit、无变化比较改序列化比较、新增 .target-level 样式；bin/settings-page.js 净增 0 行（接线调用点不变）— 验证：node --test test/settings-web.test.mjs + wc -l bin/settings-page.js bin/settings-page-targetlist.js
- [x] T6 文档与全量回归：README「Effort 覆写」小节补条目档位形态（字符串 = 继承全局、对象 = 显式档位）、`{url}` 归一为字符串、最长路径前缀仲裁、旧配置兼容；CLAUDE.md 更新 base-url-match.js 与 settings-page-targetlist.js 行说明 — 验证：npm test（node --test --test-timeout=15000 "test/"*.test.mjs）
- [x] T7 收尾核对：确认 bin/settings-page.js、bin/settings-page-targetlist.js、src/proxy.js、src/settings.js、src/base-url-match.js 均 <800 行，默认配置与旧 string[] 配置下既有 effort / usage-scale 测试全绿 — 验证：wc -l + npm test

## 验收标准
- [ ] 旧 `baseUrls: ["https://a.com"]` 配置：行为与上一版本一致（全量覆写或定向覆写全局 `level`），无需迁移
- [ ] `baseUrls: [{ url: "https://a.com", level: "max" }, "https://b.com"]`：a.com 上游收到 max、b.com 上游收到全局 level、其余上游保留 CC 本地档位
- [ ] 同时配置 `https://a.com` 与 `https://a.com/api` 且档位不同时，上游 `https://a.com/api/x` 取 `/api` 条目的档位（最长前缀优先）
- [ ] `{ url: "https://a.com" }`（无 level）被归一为字符串形态，语义等同「继承全局档位」
- [ ] 列表含重复规范 URL（如 `["https://a.com", { url: "https://a.com/", level: "max" }]`）时归一后仅保留首项（字符串形态 → 继承全局）；尾斜杠归一后视为同一 URL，只计一次
- [ ] `enabled=false` 时与非 CC UA / 非 JSON body 路径仍逐字节透传，与档位配置无关
- [ ] 设置页 Effort 每行可独立选档（含「继承全局」），非法 URL 本地拦截且不提交；usageScale 列表行为与现状一致
- [ ] 设置 API 对非法条目（非数组 / 项非字符串非对象 / url 非法 / level 非枚举）返回 400；usageScale 既有 PATCH 行为不变
- [ ] 全量测试通过；bin/settings-page.js、bin/settings-page-targetlist.js、src/proxy.js、src/settings.js、src/base-url-match.js 均 <800 行

（本次为轻量 OpenSpec，无 spec.md / design.md）