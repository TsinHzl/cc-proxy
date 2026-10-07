# 任务清单：suggestion-mode-toggle

## 状态：ARCHIVED

## 任务
- [x] 1. `src/suggestion-mode.js`：`isSuggestionModeRequest(payload)` 识别（末条 user 消息，含"历史中间位置不拦截"反例覆盖）+ `buildSuggestionResponse(stream)` 空响应构造（流式 `message_delta` 固定携带 `usage: { output_tokens: 0 }`，与非流式语义一致，单测快照断言），含单元测试（`test/suggestion-mode.test.mjs`，覆盖字符串/块数组/误伤边界）
- [x] 2. `src/settings.js`：新增顶层 `forwardSuggestionMode` 布尔配置（默认 false），**`normalizeConfig`/`writeConfig` 顶层键合并适配**（单测覆盖"先写开关、再写 thinkingWindow、开关保留"防丢失）
- [x] 3. `src/proxy.js` 挂接：CC UA 请求转发前检测，开关关闭且命中时返回空响应（stream 分流），**拦截路径零 `usage.record`、零 debug 日志**；端到端测试（`test/proxy-suggestion.test.mjs`：拦截两态 + 非命中透传 + mock upstream 断言未收到请求体）
- [x] 4. `bin/claude-proxy.js` 读配置注入 + `bin/settings-cli.js` 菜单改版（编号项渲染/按键路由/非 TTY 行解析），`1` 键切换开关即时写盘重绘；**顺带修复遗留缺陷：settings-cli.js 缺 `writeConfig` import（写入路径 ReferenceError）**；settings-cli 测试补按键交互断言
- [x] 5. README.md / README.en.md 新增「Suggestion Mode 输入建议」章节；全量回归 `npm test`

## 验收标准
- [ ] 默认（无配置/开关关闭）时，CC 建议请求被拦截返回空响应，主对话请求正常转发，usage.json 零增量、debug 日志零文件
- [ ] 设置页 `1` 键开启后，建议请求正常转发上游（mock upstream 断言收到 `[SUGGESTION MODE` 请求体），其他行为不变
- [ ] 非 CC UA 流量全程不受影响
- [ ] `npm test` 全量通过
