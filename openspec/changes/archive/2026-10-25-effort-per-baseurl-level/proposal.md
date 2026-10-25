# 变更提案：effort-per-baseurl-level

## 背景

Effort 覆写在 2026-10-25（effort-override-baseurl-targeting）已支持按目标上游定向，但档位仍是
单一全局 `effortOverride.level`：命中的所有上游只能共用同一档位。多上游场景下用户实际需要
「A 上游用 high、B 上游用 max」——例如同一账号下接不同能力的上游，或对某个上游做降档以省额度。

本次让 `effortOverride.baseUrls` 的每个条目自带档位，全局 `level` 降级为「未指定条目的兜底档位」，
使既有配置与既有语义零破坏。

## 目标范围

**在范围内：**
- `effortOverride.baseUrls` 条目支持两种形态：纯字符串 `"https://a.com"`（继承全局档位）与
  对象 `{ url, level }`（显式档位）。二者可在同一数组中混合
- 全局 `effortOverride.level` 保留，语义变为「条目未指定档位时的兜底」；`enabled=false` 时仍整
  特性关闭，与列表无关
- 多条目同时命中同一上游的仲裁规则：**最长路径前缀优先**（更具体的条目胜出）
- `{ url }` 对象（档位字段缺失或非法）归一为纯字符串形态——即「未指定档位」只有一种存储表达
- 重复条目去重：归一化后指向同一规范 base URL 的条目（含字符串与对象混合的重复）只保留首次
  出现的那条及其档位，后续重复项丢弃——避免「路径长度相同」时的排序稳定性成为隐式规则
- 请求侧按每个候选 entry 的生效档位构造请求体；最多按「本请求实际用到的档位种数」序列化 body
  （惰性 + 记忆化，非命中 entry 复用基准体）
- 设置页 Effort 目标列表每行新增档位下拉（含「继承全局」空选项）；usageScale 列表保持 URL 单列
- 设置 API 对 `effortOverride.baseUrls` 接受混合数组（字符串须为合法 http(s) URL；对象须
  `url` 合法且 `level` 若存在须为枚举值），否则 400；`usageScale.baseUrls` 校验口径不变
- 配置容错：逐项校验、非法项丢弃、不整体回退；旧 `string[]` 配置读入即等价于「全部继承全局档位」
- 文档：README「Effort 覆写」小节补条目档位与仲裁规则；CLAUDE.md 对应行说明更新

**不在范围内：**
- 上游侧 failover 之外的档位选择（如按模型、按请求 token 数选档）
- usageScale 的按条目比例（本次仅 Effort 条目带值）
- 热加载（仍为下次启动会话生效）
- 一次性迁移写盘（旧配置不做自动升格，保持原形态直到用户在设置页修改该列表）
- `bin/settings-web.js` 超 800 行的拆分（既有问题，不在本变更范围）

## 技术方案

1. **匹配模块（src/base-url-match.js）**：抽出内部命中判定 `matchesTarget(base, normalizedTarget)`
   （origin 相等 + 路径段前缀），`isBaseUrlTargetHit` 改为在其上遍历（usageScale 行为逐字节不变）。
   新增 `buildBaseUrlTargetEntries(entries)`（入参 `[{ url, value }]`，产出按**规范路径长度降序**
   排列的条目数组，无合法项 → null；同规范串去重，作为配置层之外的防御性收口）与
   `resolveBaseUrlTargetValue(base, targetEntries)`
   （返回首个命中条目的 `value`；**未命中返回 `undefined`**）。降序排列使「最长前缀优先」由
   数据结构保证，调用方无需二次排序。
2. **配置（src/settings.js）**：`cleanBaseUrls` 内的单值校验抽为 `cleanBaseUrl(value)`
   （trim 非空 + `new URL` 可解析 + http/https）；新增 `cleanEffortTargets(input)`：
   - 字符串项 → 合法则保留为字符串（继承全局）
   - 对象项 → `{ url, level }` 且 level ∈ EFFORT_LEVELS 保留对象；level 缺失/非法但 url 合法
     则归一为纯字符串（`{ url }` 无第三种形态）
   - 其余（非字符串非对象、url 非法）逐项丢弃；非数组 → `[]`
   - 去重：以 `normalizeBaseUrl` 规范串判重，已出现过的规范串直接跳过（保留首次出现条目的形态
     与档位）；故 `"https://a.com"` 与 `"https://a.com/"`、以及字符串与对象形态的同 URL 均判为重复
   `normalizeConfig` 的 `effortOverride.baseUrls` 改用 `cleanEffortTargets`；
   `usageScale.baseUrls` 仍用 `cleanBaseUrls`（口径不变）。`effortOverride.level` 语义不变
   （仍是枚举白名单兜底 `'high'`）。
3. **请求侧（src/proxy.js）**：`effortTargetSet` 改为 `effortTargets`（`buildBaseUrlTargetEntries`，
   入参由 `baseUrls` 映射为 `{ url, value: level }`）。`overrideBody` 单值变量改为
   **按档位惰性记忆化的取体函数** `bodyForLevel(level)`（`Map<level, Buffer>`；每次序列化前把
   `parsed.output_config.effort` 与 `parsed.effort` 置为该档位——两字段为核心覆写点，沿用现状）。
   `baseBody` 定格时机不变。构造 targets 时逐 entry 求生效档位：
   ```
   effortTargets === null → 全局 effortOverride.level（未配置列表 = 全量覆写）
   命中条目 value === null/undefined 之「命中未指定」→ 全局 level
   命中条目 value 为档位 → 该档位
   未命中 → null → entry 用 baseBody（保留 CC 本地档位）
   ```
   `body` 变量不再叠加覆写（恒等于 `baseBody`），供转发层作为无 `entry.body` 时的回退。
4. **转发层（src/upstream.js）**：不改动——既有 `entry.body ?? bodyBuffer` 逐 entry 取体逻辑已
   满足多档位需求，逐 entry body 的六条收尾路径已被上一变更验证。
5. **设置 API（bin/settings-web.js）**：从 `isValidBaseUrlArray` 抽单值判定 `isHttpUrl(text)`；
   新增 `isValidEffortTargetArray(value)`（字符串项走 `isHttpUrl`；对象项须为非数组对象、
   `url` 走 `isHttpUrl`、`level` 存在时须 ∈ EFFORT_LEVELS），`effortOverride.baseUrls` 改用它；
   `.baseUrls` 边界归一改为按 group 分流：usageScale 逐项 trim，effort 逐项 trim 且对象项改写为
   `{ url, level? }`（丢弃 `level: undefined` 键，避免落盘出现空字段）。
6. **设置页列表工厂（bin/settings-page-targetlist.js）**：列表描述新增可选 `levels` 字段
   （EFFORT_TARGET_LIST 填 6 档枚举 + 「继承全局」空值项，SCALE_TARGET_LIST 不填）。
   - `buildTargetListHtml`：`levels` 存在时每行渲染档位 `<select class="target-level">`
   - 脚本侧：`addRow` 依 `levels` 决定是否创建 select；`currentValues` 对 effort 产出混合数组
     （空档位 → 纯字符串，有档位 → `{ url, level }`）；`render` 兼容字符串与对象两种输入；
     `syncControls` 一并禁用 select；select 的 `change` 触发 `submit()`；与快照的「无变化」比较
     改为序列化比较（数组内为对象时逐项比较失效）
   - 样式：新增 `.target-level` 规则（行内 flex，窄宽度）
   - **行数控制**：`bin/settings-page.js` 现状 783/800 行，本次**净增 0 行**——列表描述、HTML、
     脚本、样式全部留在工厂模块内，settings-page.js 的接线调用点不变。
7. **测试**：`test/base-url-match.test.mjs`（条目构造排序、最长前缀优先、未命中 undefined）；
   `test/settings.test.mjs`（混合形态归一四种分支）；`test/settings-web.test.mjs`（PATCH 混合
   数组合法 / 各非法形态 400 / 边界 trim；页面 effort 行档位下拉渲染与提交）；
   `test/proxy-effort.test.mjs`（逐条目档位、最长前缀仲裁、条目继承全局、未命中不覆写、
   同一请求内两种档位并存的 body 隔离）。

## 预期影响

- 旧配置（`string[]`）读入后语义与当前完全一致：全部条目继承全局 `effortOverride.level`
- `{ url }` 对象形态被归一为字符串：用户手写的冗余对象不会在后续写盘时保留
- 同一请求内不同候选上游可能携带不同档位体，新增序列化次数 ≤ 6（枚举档位数）；未命中上游复用
  基准体，无额外序列化
- `isBaseUrlTargetHit` 由「直接遍历 Set」改为「遍历 Set 调用共享判定函数」，usageScale 的匹配
  结果与性能量级不变（集合规模为个位数）
- 设置页 Effort 列表行变宽（URL + 档位 + 删除）；usageScale 列表零变化

## 风险

- **多命中仲裁的语义可见性**：最长前缀优先是隐式规则，用户可能期望「后添加者优先」。以 README
  显式说明 + 「命中多条时更具体者胜出」提示文案缓解；深路径与浅路径并列的配置在设置页不额外
  提示（避免增加行数）
- **档位体种类膨胀**：同一请求若多个候选上游档位各异，会序列化多份 body（每份为完整请求体）。
  上限为枚举 6 种 + 基准体，且仅在本请求已有候选上游命中时产生；以惰性记忆化保证同档位只序列化
  一次
- **`parsed` 复用序列化**：多个档位共用同一 `parsed` 对象，序列化前才写入该档位字段，若序列化
  与后续继续修改交错会串档。以「同一函数内连续 赋值→序列化→入缓存」收口，且 `baseBody` 在任何
  覆盖之前定格
- **快照比较口径变化**：effort 列表由数组值比较改为序列化比较，形式不同但语义等价的对象
  （如 `{url, level}` 与 `{level, url}`）会被判为「有变化」而多发一次 PATCH。服务端返回的形态由
  settings 层归一，实际不会出现键序差异
- **配置回调写盘**：`writeConfig` 逐字段浅合并，`baseUrls` 数组整体替换，无需改动；不存在新旧
  形态混合残留（数组替换即丢弃旧项）