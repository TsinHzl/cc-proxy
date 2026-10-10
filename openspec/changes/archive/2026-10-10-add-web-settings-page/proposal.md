# 变更提案：add-web-settings-page

## 背景
当前 `cc-proxy --setting` 使用终端按键菜单，仅能配置 Suggestion Mode 转发，无法直观展示配置说明，也不能控制思考内容文本化行为。需要将其替换为本地 Web 设置页，并保持项目零运行时依赖。

## 目标范围
**在范围内：**
- 执行 `cc-proxy --setting` 时启动仅监听 `127.0.0.1` 随机端口的临时 HTTP 服务，并自动打开默认浏览器。
- 页面采用参考截图的深色背景、分组卡片、行式配置和青色开关风格。
- 页面仅提供 `Suggestion Mode 输入建议转发` 与 `思考内容文本化展示` 两个即时保存开关。
- `forwardSuggestionMode=false` 时继续拦截建议请求；开启后转发上游。
- 新增 `thinkingAsText=true` 默认配置；关闭后恢复 Claude Code 原生折叠 thinking 块。
- 最后一个设置页面关闭或连接失效后，临时服务自动退出。
- 保持旧配置兼容，并更新测试与中文 README。

**不在范围内：**
- 不实现账号选择、负载均衡、RPM、监听端口、上游代理、Admin Password 或语言切换。
- 不引入前端框架、CSS 库、浏览器自动化框架或其他运行时依赖。
- 不热更新已经运行的代理会话；设置即时落盘，但在下次启动代理会话时生效。
- 不删除遗留 `thinkingWindow` 配置字段。

## 技术方案
- 新增独立 `settings-web` 模块，使用 Node.js 内置 `http`、`crypto` 与 `child_process`。
- 使用高熵 capability token 保护设置 API；token 仅放入 URL fragment，由页面通过自定义 header 提交。
- 使用经过认证的流式租约连接跟踪页面生命周期；最后一个租约断开并超过短暂宽限期后关闭服务。
- 页面首次租约连接超时为 30 秒，租约心跳间隔为 10 秒，最后租约断开宽限期为 2 秒。
- 配置采用同目录临时文件 + rename 原子替换；写入失败返回 HTTP 500，页面回滚开关且服务继续运行。
- 扩展持久化配置为 `thinkingAsText: true`，由 CLI 启动代理时读取不可变快照并注入流式与非流式处理链路。

## 预期影响
- `cc-proxy --setting` 从终端菜单变为浏览器页面。
- 旧配置缺少 `thinkingAsText` 时自动使用 `true`，现有文本化行为不变。
- 关闭文本化后，Claude Code 将重新显示原生折叠 thinking 块及其签名事件。

## 风险
- 浏览器关闭通知不可靠：采用服务端可观测的长连接租约、心跳和断开宽限期，不依赖 `beforeunload`。
- localhost 服务可能被跨站请求攻击：仅监听 loopback，并校验 Host、Origin、capability token、方法、字段和请求体大小。
- 配置部分写入可能覆盖另一字段：继续执行读取后合并，并增加交叉保留测试。
- thinking 关闭态可能丢失原生数据：复用现有事件透传能力，并验证流式与非流式关闭态。
