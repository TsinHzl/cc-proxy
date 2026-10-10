## MODIFIED Requirements

### Requirement: 配置持久化与容错
The system SHALL 将设置持久化到 `~/.cc-proxy/config.json`，默认配置 SHALL 包含 `thinkingWindow: { enabled: false, lines: 10 }`、`forwardSuggestionMode: false` 与 `thinkingAsText: true`；配置文件缺失、损坏或字段非法时 SHALL 对相应字段回退默认值，不得抛出异常或中断启动。

#### Scenario: 首次使用无配置文件
- **WHEN** `~/.cc-proxy/config.json` 不存在时读取配置
- **THEN** 返回完整默认配置，不报错
- **AND** 不自动创建配置文件

#### Scenario: 旧配置自动兼容
- **GIVEN** 配置文件不包含 `thinkingAsText`
- **WHEN** 读取配置
- **THEN** `thinkingAsText` 为 `true`
- **AND** 其他合法字段保持原值

#### Scenario: 配置文件损坏
- **GIVEN** `~/.cc-proxy/config.json` 内容为非法 JSON
- **WHEN** 读取配置
- **THEN** 回退完整默认配置，不抛出异常

#### Scenario: 行数非法回退
- **GIVEN** 配置中 `thinkingWindow.lines` 为 0、负数、非整数或大于 100
- **WHEN** 读取配置
- **THEN** `lines` 回退为默认 10，其余字段正常解析

#### Scenario: 单字段更新
- **GIVEN** 两个公开开关已有持久化值
- **WHEN** 设置页只修改其中一个开关
- **THEN** 被修改字段即时写盘
- **AND** 另一个开关及 legacy `thinkingWindow` 保持原值
- **AND** 配置通过同目录临时文件与 rename 原子替换

#### Scenario: 新配置文件安全权限
- **GIVEN** 配置文件尚不存在
- **WHEN** 设置页首次保存设置
- **THEN** 创建的 `config.json` mode 为 `0600`

#### Scenario: 保留已有配置权限
- **GIVEN** 已有 `config.json` 具有自定义 mode
- **WHEN** 设置页保存设置
- **THEN** 原子替换后的配置文件保留原 mode

### Requirement: --setting 交互式设置页
The system SHALL 在 CLI 收到 `--setting` 参数时启动仅监听 `127.0.0.1` 随机端口的临时 Web 设置服务并打开默认浏览器，不启动代理或 Claude Code；页面 SHALL 采用深色分组卡片风格，仅展示 `Suggestion Mode 输入建议转发` 与 `思考内容文本化展示` 两个即时保存开关。

#### Scenario: 进入设置页
- **WHEN** 用户执行 `cc-proxy --setting`
- **THEN** 本地设置服务启动并打开浏览器
- **AND** 页面显示两个开关的当前状态、行为说明及下次会话生效提示
- **AND** 不启动代理或 Claude Code
- **AND** 终端和浏览器 URL 仅包含 `http://127.0.0.1:<port>/`，不包含 API token

#### Scenario: 页面兑换 API token
- **GIVEN** 用户加载设置页并获得该页面独立的一次性 Bootstrap nonce
- **WHEN** 页面在 30 秒内以正确 Origin 调用 Bootstrap API
- **THEN** 服务返回 API token，并立即使该 nonce 失效
- **AND** 后续重放该 nonce 返回 401

#### Scenario: 错误 Origin 不消费 nonce
- **GIVEN** 页面持有尚未过期且未消费的 Bootstrap nonce
- **WHEN** 错误 Origin 提交该 nonce
- **THEN** 服务返回 403
- **AND** 正确 Origin 仍可在有效期内兑换该 nonce

#### Scenario: Bootstrap nonce 容量受限
- **WHEN** 未消费且未过期的 Bootstrap nonce 达到 256 个后继续加载页面
- **THEN** 服务淘汰最旧 nonce
- **AND** 内存中的未消费 nonce 不超过 256 个

#### Scenario: 页面初始化
- **WHEN** 设置页尚未同时完成 Bootstrap、设置读取和页面租约建立
- **THEN** 两个开关均保持禁用
- **AND** 任一步骤失败或租约断开后页面保持或恢复禁用

#### Scenario: 切换建议转发
- **WHEN** 用户切换 `Suggestion Mode 输入建议转发`
- **THEN** 页面通过认证 API 写入 `forwardSuggestionMode`
- **AND** 保存期间两个开关均被禁用
- **AND** 写入成功后采用 API 返回的两个完整权威设置并显示已保存状态

#### Scenario: 切换思考文本化
- **WHEN** 用户切换 `思考内容文本化展示`
- **THEN** 页面通过认证 API 写入 `thinkingAsText`
- **AND** 保存期间两个开关均被禁用
- **AND** 写入成功后采用 API 返回的两个完整权威设置并显示已保存状态

#### Scenario: 保存失败
- **WHEN** 配置写入失败或 API 拒绝请求
- **THEN** API 返回 HTTP 500 或对应 4xx，且不得返回保存成功
- **AND** 页面按最近一次服务端权威快照恢复两个开关并显示错误
- **AND** 设置服务保持可用

#### Scenario: 正文大小边界
- **WHEN** PATCH JSON 正文精确为 1024 字节
- **THEN** 服务正常解析并处理请求
- **WHEN** 已知 `Content-Length` 为 1025 字节
- **THEN** 服务在订阅正文累积前返回 413 并 drain 请求
- **WHEN** chunked 正文收到第 1025 字节
- **THEN** 服务立即返回 413，不等待请求结束

#### Scenario: 正文读取超时或中止
- **WHEN** 请求正文在 5 秒绝对期限内未读取完成
- **THEN** 服务返回 408，且持续到达的数据不得重置期限
- **WHEN** 客户端在正文完成前中止请求
- **THEN** 请求处理有界结束，且服务继续处理后续请求
- **AND** 对 408 或 chunked 413，服务先完成错误响应再终止未完成请求

#### Scenario: 关闭最后一个页面
- **GIVEN** 设置页至少成功建立过一个页面租约
- **WHEN** 最后一个页面的租约 socket 关闭或报错，且 2 秒内未重连
- **THEN** 设置服务释放端口
- **AND** `cc-proxy --setting` 命令正常退出

#### Scenario: 宽限期内重新连接
- **GIVEN** 最后一个页面租约已经断开
- **WHEN** 新页面在 2 秒宽限期内建立租约
- **THEN** 服务取消原关闭任务并继续运行
- **AND** 新租约断开且 2 秒内无重连后才释放端口

#### Scenario: 关闭残留连接
- **GIVEN** 服务开始关闭后仍有 socket 阻止 `server.close()` 完成
- **WHEN** 关闭等待达到 1 秒
- **THEN** 服务销毁所有仍然活跃的残留 socket
- **AND** 单个 socket 销毁失败不阻止其他 socket 被清理
- **AND** 正常 close callback 已完成时不再强制销毁 socket

#### Scenario: 页面未连接
- **WHEN** 浏览器未能在服务启动后 30 秒内建立页面租约
- **THEN** 设置服务自动退出
- **AND** 不永久占用终端或端口

#### Scenario: 未授权访问
- **WHEN** 请求缺少正确 capability token、Host 或 Origin 校验失败，或提交未知字段及非布尔值
- **THEN** 服务拒绝请求
- **AND** 配置文件不发生变化
