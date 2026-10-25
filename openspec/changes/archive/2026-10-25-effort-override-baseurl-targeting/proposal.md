# 变更提案：effort-override-baseurl-targeting

## 背景

Effort 覆写（2026-10-10 归档 add-effort-override）当前为全局开关：`effortOverride.enabled=true`
时对所有 Claude Code 请求统一改写 effort 档位。用量展示缩放已在 2026-10-19
（usage-scale-baseurl-targeting）支持按目标上游定向。用户提出让 Effort 覆写具备同等能力：
多上游场景下只对特定上游覆写档位，其余上游保留 CC 本地设置的档位；未配置目标列表时维持
「对所有上游覆写」的现行为。

## 目标范围

**在范围内：**
- `effortOverride` 新增 `baseUrls: string[]`（默认 `[]`），与 `usageScale.baseUrls` 同构
  （单一全局档位 + 定向列表）
- 请求侧匹配语义：enabled=true 且列表为空 → 全部上游覆写（现行为）；列表非空 → 仅命中列表
  的上游收到覆写后的 body，未命中上游按未覆写 body 转发
- failover 兼容：按「每个候选上游 entry」逐项判定，切换后该上游收到与其 base 匹配的 body
  （upstream.js entry 新增可选 `body` 字段）
- 匹配原语抽公共模块（usageScale 与 effortOverride 共用同一实现）
- 设置页：Effort 覆写区块下新增目标上游动态列表（复用泛化的列表工厂，不复制代码）
- 设置 API：`effortOverride.baseUrls` 入 ALLOWED_KEYS，值须为字符串数组且逐项 http(s) 可解析，
  否则 400
- 配置容错：normalizeConfig 逐项校验丢弃非法项；writeConfig 数组整体替换（现有逐字段浅合并已满足）
- 文档：README 新增「Effort 覆写」小节（baseUrls 与匹配规则）、CLAUDE.md 架构树更新

**不在范围内：**
- 每个 base URL 独立档位（维持单一全局 level）
- 热加载（配置重启 `cc-proxy` 后生效，与既有覆写类设置一致）
- 非 CC UA、非 JSON body 的任何改写（维持原样透传）
- thinking 文本剥离 / 系统提示词覆写的定向化（仍为全局）

## 技术方案

1. **公共匹配模块**：新建 `src/base-url-match.js`，承载 `normalizeBaseUrl` /
   `buildBaseUrlTargetSet` / `isBaseUrlTargetHit`（语义与现 usage-scale 实现完全一致：协议 + host +
   归一端口相等、路径段前缀、尾斜杠归一、空列表/全非法 → null 表示全量）；`src/usage-scale.js`
   改为从该模块导入并删除本地副本；匹配测试拆至 `test/base-url-match.test.mjs`。
2. **请求侧双 body（src/proxy.js）**：CC UA JSON 分支内先完成历史剥离 + 系统提示词覆写得到
   `baseBody`；`effortOverride.enabled` 时额外构造 `overrideBody`（`output_config.effort` 与
   top-level `effort` 均覆写为 level）。`effortTargetSet = buildBaseUrlTargetSet(baseUrls)` 为 null
   （未配置 / 全部非法）时所有 entry 用 `overrideBody`；非空时 `entry.base` 命中用 `overrideBody`、
   未命中用 `baseBody`。逐 entry 写入可选 `body` 字段（entry 字段名 `scaleBase` 统一更名为 `base`，
   供两个定向特性共用）。
3. **转发层（src/upstream.js）**：`attempt` 内 `const body = entry.body ?? bodyBuffer`，
   `forwardRequest(req, body, target, ...)` 与 `respond(upstreamRes, body)` 均用该 body；
   `entry.body` 缺省时行为与现状逐字节一致。
4. **配置（src/settings.js）**：DEFAULT_CONFIG.effortOverride 增 `baseUrls: []`；normalizeConfig
   复用与 usageScale.baseUrls 相同的逐项校验（字符串 + trim 非空 + `new URL` 可解析 + http/https），
   非法项逐项丢弃；writeConfig 无需改动。
5. **设置 API（bin/settings-web.js）**：ALLOWED_KEYS 增 `effortOverride.baseUrls`；抽出
   `isValidBaseUrlArray(value)` 供两处共用；以 `.baseUrls` 结尾的 key 在边界统一 trim。
6. **设置页列表工厂**：`bin/settings-page-scaletargets.js` 改造为
   `bin/settings-page-targetlist.js` 的 `createTargetListFragment({ key, group, title, emptyHint, hint })`
   工厂，按 key 生成前缀化的样式类、元素 id（`<key>TargetList` / `<key>TargetAdd`）、脚本变量与函数名；
   settings-page.js 以 `scale`（group=usageScale）与 `effort`（group=effortOverride）实例化两次，
   `setDisabled` 同步调用两个 sync 函数，`applySettings` / `acceptSettings` 增加
   `effortOverride.baseUrls` 的回填与快照。key='scale' 保持原 id / 类名 / 变量名，既有 scale 列表零行为变化。
   **行数控制**：`bin/settings-page.js` 现状 779/800 行，本次接线须将新增量压到净增 ≤ 15 行——
   工厂模块除 HTML/脚本片段外再导出「接线包」（`html` / `syncControls` / `render` / `snapshot` 四项），
   settings-page.js 只保留两组实例化常量与调用点；若仍越限，则把 Effort 卡片 HTML 一并下沉至工厂模块。
7. **测试**：base-url-match 单元；settings normalize（默认 / 非法丢弃 / 合并保留）；settings-web
   PATCH（合法 / 非法 400 / 非数组 400）与页面列表交互；proxy-effort（命中覆写、未命中透传、
   空列表全量、双向 failover 逐 entry）；upstream 层 entry.body 透传。

## 预期影响

- 默认配置（`baseUrls: []`）下行为与现版本一致，升级用户零迁移成本
- 目标列表非空时，未命中上游请求 body 与「覆写关闭」时一致（effort 恢复 CC 本地设置）
- `entry.body` 为可选字段，既有 targets 构造与测试不受影响
- 设置页新增一个可交互列表区块；usageScale 列表经工厂化后行为不变（页面测试回归保证）

## 风险

- **逐 entry body 完备性**：每个 entry 都必须带 body（未命中带 `baseBody`），漏赋会让未命中上游
  收到覆写版；以「构造 targets 时统一赋值」单点收口规避
- **匹配语义共用**：与 usageScale 共用同一实现，语义分歧不可能出现，但改一处会同时影响两个特性
  （视为收益而非风险，行为一致性由共享测试保证）
- **工厂泛化触碰既有代码**：usageScale 列表代码被改写为工厂调用，需以现有页面测试确认零行为变化
- **enabled 默认 true**：新增字段默认空列表，故默认语义不变；若用户配置了列表但上游未命中，
  表现为「覆写不生效」——README 需明确说明匹配规则