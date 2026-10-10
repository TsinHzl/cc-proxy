## 上下文
项目使用 Node.js >=18 ESM 且无运行时依赖。现有 `--setting` 是终端菜单；代理启动时读取一次配置。thinking 转换器已支持关闭态事件透传，但代理层仍硬编码开启，非流式路径也始终改写 thinking 块。

## 目标 / 非目标
### 目标
- 提供自包含、可测试、仅监听本机的 Web 设置服务。
- 提供两个即时落盘开关，并维持旧配置默认行为。
- 可靠识别最后一个页面关闭，自动释放端口并结束命令。
- 对设置 API 实施 localhost 场景所需的纵深防护。

### 非目标
- 不提供远程管理、账号系统、登录页或通用管理后台。
- 不提供运行中代理的热重载。
- 不追求参考截图的逐像素复制。

## 决策
### 页面与文件边界
- `bin/settings-web.js` 负责临时 HTTP 服务、API 和打开默认浏览器。
- `bin/settings-session.js` 负责页面租约、定时器、socket 跟踪与关闭流程；`bin/settings-web.js` 保留原生命周期公开导出。
- 页面使用模块内自包含 HTML/CSS/JS，不增加构建链或静态资源目录。
- `src/settings.js` 继续作为唯一配置 schema、归一化和写入边界。

### HTTP 与安全
- 服务固定监听 `127.0.0.1:0`，不得回退到 `0.0.0.0`。
- 服务生命周期内生成 256-bit 随机 API token，但终端和浏览器只暴露 `http://127.0.0.1:<port>/` 基础 URL。
- 每次 `GET /` 独立签发一个 256-bit Bootstrap nonce 并嵌入该页面；nonce 30 秒后失效，成功兑换后立即删除，重放返回 401。
- 未消费 nonce 最多保留 256 个，签发新 nonce 前清理过期项，超限时淘汰最旧项。
- 页面通过同源 `POST /api/bootstrap` 提交 nonce，成功后获得 API token；错误 Origin 必须在 nonce 查询或消费前返回 403。
- 后续 API 请求通过 `X-CC-Proxy-Token` header 提交 token；token 不进入 URL、终端输出或 Referer。
- API 仅包含：
  - `POST /api/bootstrap`：用页面 nonce 兑换 API token。
  - `GET /api/settings`：读取两个公开布尔字段。
  - `PATCH /api/settings`：原子更新一个允许字段。
  - `GET /api/session`：建立经过认证的流式页面租约。
- 所有请求先校验当前 `Host`；Bootstrap 额外校验精确 `Origin`，其余 API 校验 token，PATCH 再校验精确 `Origin`。
- PATCH 仅接受 `{"key":"forwardSuggestionMode"|"thinkingAsText","value":boolean}`，请求体上限为 1024 字节。
- 已知 `Content-Length > 1024` 时立即 drain 并返回 413；chunked 正文收到第 1025 字节时立即返回 413，不等待 `end`。
- 正文读取使用 5 秒绝对超时，`data` 事件不得重置计时；超时返回 408，客户端中止必须有界结束处理。
- 408/413 对未完成请求先完整发送错误响应，再终止请求连接。
- token 或 nonce 错误返回 401，Host/Origin 错误返回 403，方法错误返回 405，content-type 错误返回 415，请求体超限返回 413，读取超时返回 408，非法 JSON、未知字段或非布尔值返回 400。
- 所有响应设置 `Cache-Control: no-store`；页面设置 CSP、`frame-ancestors 'none'`、`Referrer-Policy: no-referrer` 与 `X-Content-Type-Options: nosniff`。

### 页面状态
- HTML 中两个开关初始均为 disabled。
- Bootstrap 成功后并发读取设置并建立页面租约；两者均成功后才允许交互。
- PATCH 期间同时禁用两个开关；成功后采用服务端返回的两个完整权威值。
- PATCH 失败时按最近权威快照回滚两个开关并显示错误；租约失败或断开后重新禁用页面。

### 页面生命周期
- 页面通过 `fetch` 建立 `/api/session` 流式连接并持续读取响应。
- 服务维护活跃租约计数，每 10 秒写入 SSE comment 心跳；socket `close` / `error` 定义为租约失效。
- 最后一个租约断开后启动 2 秒宽限期；刷新期间的新租约可取消退出。
- 服务启动后若 30 秒内从未建立租约，则自动退出，避免浏览器打开失败后永久驻留。
- 关闭流程清理定时器和响应，再调用 `server.close()`；1 秒后仍未完成时销毁所有残留 socket，单个 socket 销毁失败不得阻止其他 socket 清理。
- 正常 `server.close()` callback 到达时取消强制关闭计时器，不得无条件销毁已正常关闭的 socket，也不得用 `process.exit()` 截断响应。

### 配置模型
- 新增顶层字段 `thinkingAsText: true`。
- 缺失或非法值统一回退 `true`，确保升级不改变现有行为。
- `forwardSuggestionMode` 与 `thinkingAsText` 均采用单字段 PATCH 和读取后合并。
- 保留隐藏的 legacy `thinkingWindow`，避免本次引入无关破坏性迁移。
- 配置写入使用同目录独占临时文件与 rename 原子替换；新配置文件使用 `0600`，更新已有配置时保留原 mode。
- 写入或 rename 失败时清理临时文件，API 返回 500，页面恢复完整权威状态，服务保持运行。

### thinking 行为
- `createProxyServer` 新增默认值为 `true` 的 `thinkingAsText` 参数。
- SSE 路径把该值传给现有转换器；关闭时保留 thinking、thinking_delta 与 signature_delta 的事件语义。
- 非流式路径开启时继续改写 thinking；关闭时返回原始 body，同时仍解析 usage。
- 请求侧已文本化历史清理继续执行，以兼容切换前产生的旧会话历史。
- 非 Claude Code UA 始终保持透明透传。

### 浏览器打开
- 设置服务监听成功后调用当前系统的默认浏览器打开命令，并同时输出本地 URL。
- 浏览器启动子进程不得持有设置服务生命周期。

## 风险 / 权衡
- 自包含页面减少构建和分发复杂度；生命周期独立成内部模块，避免 HTTP 路由、页面模板与 socket 状态集中在超大文件中。
- 页面关闭检测依赖 TCP/HTTP 连接状态，浏览器或网络栈可能延迟释放；心跳和宽限期用于在可靠性与退出速度之间折中。

## 迁移方案
- 旧配置缺少 `thinkingAsText` 时按默认值 `true` 读取，维持现有行为。

## 待决问题
- 无。
