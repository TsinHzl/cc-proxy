# 任务清单：usage-dashboard-and-cache-stats

## 状态：DONE

## 任务
- [x] 任务 1：扩展 `src/usage.js` — `extractUsage`/`record`/`normalizeDay` 支持 `message.model` 按模型分组累计（byModel，缺失归 `unknown`），旧格式兼容读取；扩展单元测试覆盖旧格式读取、按模型累计、unknown 归类。验证：`node --test test/usage.test.mjs` 通过
- [x] 任务 2：扩展 `src/settings.js` — DEFAULT_CONFIG 与 normalizeConfig 白名单纳入 `alerts.dailyTokens`（非数字回退默认）与 `models.<model>.pricing`（非对象回退默认）；单元测试。验证：`node --test test/settings.test.mjs` 通过
- [x] 任务 3：新增 `src/pricing.js` — 内置默认价表 + 前缀匹配 + config `models.<model>.pricing` 覆盖 + `estimateCost`（未收录模型返回 null）+ `cacheHitRate(day)` 计算；单元测试覆盖前缀匹配、覆盖生效、未收录模型、零分母 hitRate。验证：`node --test test/pricing.test.mjs` 通过
- [x] 任务 4：`src/proxy.js` 将 message_start 的 model 字段传入 usage 记录（仅改调用点，不动 thinking 管线）；更新相关测试。验证：现有 proxy 测试通过
- [x] 任务 5：`bin/settings-web.js` 新增 `GET /api/usage`（近 7 天数组：tokens/requests/byModel/hitRate/cost/阈值比较结果），走现有认证链；测试覆盖认证失败 401/403 与正常返回形状。验证：`node --test test/settings-web.test.mjs` 通过
- [x] 任务 6：`bin/settings-page.js` 用量看板 — 近 7 天柱状图（内联 CSS/脚本，textContent 渲染含模型名）、按模型表、命中率、费用、超阈值红点；`test/settings-web.test.mjs` 补断言页面 HTML 含看板节点。验证：测试通过 + 手动 `cc-proxy --setting` 查看看板
- [x] 任务 7：CLI `bin/claude-proxy.js` 启动横幅超阈值警告 + 退出总结补缓存命中率（null 时显示 `n/a`）；e2e 测试覆盖横幅打印。验证：`node --test test/cli.test.mjs` 通过
- [x] 任务 8：README 中英版补看板/价表覆盖/告警配置说明；全量 `node --test --test-timeout=15000 "test/"*.test.mjs` 回归 + sub-agent CR

## 验收标准
- [x] usage.json 新条目含 byModel 分组；旧格式文件可正常读取且继续累计
- [x] 设置页显示近 7 天柱状图、按模型分组、缓存命中率与费用估算（未配置/未收录模型时费用显示为空而非报错）
- [x] config 配置 `alerts.dailyTokens` 后，当日用量超限在 CLI 启动时打印一条警告且设置页出现红点；未配置时零提示
- [x] 退出总结包含缓存命中率
- [x] 现有全部测试保持通过，新增模块有单元测试
