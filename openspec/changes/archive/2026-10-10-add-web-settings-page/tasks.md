# 任务清单：add-web-settings-page

## 状态：ARCHIVED

## 任务
- [x] 1. 先为 `thinkingAsText` 默认值、旧配置兼容、交叉字段保留、临时文件写入、rename 替换、失败清理及原文件不受损补充失败测试，再扩展 `src/settings.js`；验证：`node --test test/settings.test.mjs`
- [x] 2. 先补充 SSE/非流式开启与关闭模式的代理端到端失败测试，再把 `thinkingAsText` 注入两条响应链路；验证：运行新增的代理定向测试
- [x] 3. 先为深色页面与两个开关编写失败测试，再实现自包含 HTML/CSS/JS；验证：`node --test --test-name-pattern="page" test/settings-web.test.mjs`
- [x] 4. 先为设置读取、单字段 PATCH、token/Host/Origin、状态码、1024 字节上限及写盘失败编写失败测试，再实现设置 API；验证：`node --test --test-name-pattern="API" test/settings-web.test.mjs`
- [x] 5. 先为多页面租约、10 秒心跳、2 秒宽限期、刷新重连和 30 秒首次连接超时编写失败测试，再实现服务生命周期；验证：`node --test --test-name-pattern="session|lease" test/settings-web.test.mjs`
- [x] 6. 实现并测试打开默认浏览器及终端 URL 输出，确保启动子进程不持有服务生命周期；验证：`node --test --test-name-pattern="browser" test/settings-web.test.mjs`
- [x] 7. 将 `--setting` 切换到 Web 设置服务并注入两个代理配置快照；验证：`node --test test/cli.test.mjs`
- [x] 8. 更新中文 README、`openspec/config.yaml` 的非 SSE 不变量与目录说明；验证：文档与 delta specs 行为一致
- [x] 9. 执行全量回归和真实设置页冒烟；验证：`npm test`，并确认页面打开、开关落盘、关闭页面后端口释放
- [x] 10. 先补充每页面独立 Bootstrap nonce、错误 Origin 不消费、nonce 重放返回 401，以及浏览器与终端只暴露基础 URL 的失败测试，再实现同源 Bootstrap；验证：`node --test --test-name-pattern="bootstrap|base URL|browser" test/settings-web.test.mjs`
- [x] 11. 使用 `node:vm` 执行真实页面脚本，覆盖初始禁用、权威状态同步与失败回滚
- [x] 12. 实现 1024 字节正文边界、提前拒绝、客户端中止与绝对读取超时
- [x] 13. 跟踪并强制关闭残留 socket，使用手动调度器稳定生命周期测试
- [x] 14. 拆分设置路由和会话生命周期长函数
- [x] 15. 增加真实 HTTP/SSE 多租约、宽限重连与端口释放集成测试
- [x] 16. 同步 README、design、delta spec，完成全量回归、真实冒烟与最终 CR

## 验收标准
- [x] 执行 `cc-proxy --setting` 自动打开仅监听 `127.0.0.1` 的深色设置页，页面只含两个开关且不启动 Claude Code
- [x] 两个开关切换后即时写入配置、互不覆盖，并明确提示下次代理会话生效
- [x] `thinkingAsText=true` 保持现有文本化输出，`false` 恢复流式与非流式原生 thinking
- [x] 最后租约断开后 2 秒内重连不会退出，未重连时服务在宽限期结束后释放端口；首次 30 秒未连接时自动退出
- [x] 未授权或非法 API 请求不能修改配置，项目仍保持零运行时依赖
- [x] 写盘失败时 API 不返回成功、页面回滚开关并显示错误，服务仍可继续处理请求
- [x] 全量测试通过
