# 任务清单：version-usage-debug

## 状态：DONE

## 任务
- [ ] 任务 1：`src/usage.js` 用量统计模块（提取 usage / 累计 / 按天落盘 usage.json，注入路径可测）+ 单元测试
- [ ] 任务 2：`src/debug-log.js` debug 日志模块（CC_PROXY_DEBUG=1 时落盘请求/响应到 ~/.cc-proxy/logs/，容错静默）+ 单元测试
- [ ] 任务 3：`src/proxy.js` 挂接 usage 提取（SSE message_start/message_delta + 非流式 JSON）与 debug 写入 + 测试
- [ ] 任务 4：`bin/claude-proxy.js` 加 `--version`/`-v` 分支与退出时用量总结打印 + e2e 测试
- [ ] 任务 5：README 中英版补文档；`npm test` 全量回归 + sub-agent CR

## 验收标准
- [ ] `cc-proxy --version` 输出 cc-proxy 自身版本并退出，不启动代理
- [ ] 带 usage 的响应（流式/非流式）被正确累计；claude 退出后 stderr 打印总结；usage.json 按天累计且损坏时可回退
- [ ] `CC_PROXY_DEBUG=1` 时每个请求生成日志文件；关闭时零文件写入；写失败不影响代理
- [ ] 现有 41 项测试全部保持通过，新增测试通过
