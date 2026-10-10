## Purpose
cc-proxy 的设置能力：提供 `cc-proxy --setting` 启动的本地 Web 设置页（深色分组卡片、即时保存开关与系统提示词覆写卡片）与 `~/.cc-proxy/config.json` 持久化配置读写（容错回退）。设置页仅监听 127.0.0.1，通过一次性 Bootstrap nonce 兑换 API token，并以 SSE 租约管理页面生命周期。「思考滚动窗口」实验特性因与 Claude Code Ink 渲染器不兼容（ANSI 光标控制码导致流式输出失效）已整体退役。覆写与捕获类设置修改在保存后即时落盘，但对代理流量的实际生效时机为重启 `cc-proxy` 后的新 CC 会话（主动超出，经用户确认保留）。

## Requirements

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

### Requirement: 系统提示词覆写配置
The system SHALL 将 `systemPromptOverride: { enabled, prompt }` 持久化到 `~/.cc-proxy/config.json`，默认值为 `{ enabled: false, prompt: '' }`；enabled 非布尔时 SHALL 回退 false，prompt 非字符串或 UTF-8 字节数超过 256KB 时 SHALL 回退空字符串；配置文件缺失、损坏或字段非法时不得抛出异常或中断启动。

#### Scenario: 旧配置自动兼容
- **GIVEN** 配置文件不包含 `systemPromptOverride`
- **WHEN** 读取配置
- **THEN** `systemPromptOverride` 为 `{ enabled: false, prompt: '' }`
- **AND** 其他合法字段保持原值

#### Scenario: 非法字段逐项回退
- **GIVEN** 配置中 `systemPromptOverride.enabled` 为非布尔值，或 `prompt` 为非字符串/超 256KB
- **WHEN** 读取配置
- **THEN** 非法字段回退默认值（false / ''）
- **AND** 其余字段正常解析

#### Scenario: 单字段更新保留兄弟字段
- **GIVEN** `systemPromptOverride.enabled` 与 `prompt` 已有持久化值
- **WHEN** 设置页只修改其中之一
- **THEN** 被修改字段即时写盘
- **AND** 另一字段保持原值

### Requirement: 代理捕获 CC 默认系统提示词
The system SHALL 在 CC 客户端（UA 匹配 claude-cli/claude-code）的请求经代理转发时，从请求体 `system` 字段提取纯文本并持久化到 `~/.cc-proxy/captured-system-prompt.json`（schema 为 `{ prompt: string }`）；捕获对象 SHALL 始终为覆写前的原始 system 且与覆写开关状态无关；Suggestion Mode 输入建议请求 SHALL 不参与捕获；提取或写盘失败 SHALL 静默降级，不影响请求转发。

#### Scenario: 捕获主对话请求的系统提示词
- **GIVEN** CC 发出非 Suggestion Mode 的请求且请求体含 `system` 字段
- **WHEN** 请求经代理转发
- **THEN** 提取的纯文本写入 `captured-system-prompt.json`
- **AND** 请求按原链路正常转发

#### Scenario: 覆写开启期间捕获原始 system
- **GIVEN** 系统提示词覆写已开启
- **WHEN** CC 发出请求
- **THEN** 捕获的仍是覆写前的原始 system 文本
- **AND** 用户自定义提示词不进入捕获文件

#### Scenario: 内容未变化不重复写盘
- **GIVEN** 捕获文本与已落盘内容一致
- **WHEN** 后续请求继续携带相同 `system`
- **THEN** 不再写盘

#### Scenario: Suggestion Mode 请求不捕获
- **WHEN** CC 发出以 `[SUGGESTION MODE` 开头的输入建议请求
- **THEN** 该请求的 `system` 不参与捕获

#### Scenario: system 字段缺失
- **WHEN** 请求体不含 `system` 字段
- **THEN** 不捕获，已落盘内容保持不变

#### Scenario: 非法请求体透传
- **WHEN** 请求体为非法 JSON 或非 CC UA 客户端请求
- **THEN** 不捕获，请求字节级原样转发

### Requirement: 系统提示词覆写生效
The system SHALL 在 `systemPromptOverride.enabled` 为 true 且配置的提示词非空时，将 CC 请求中已存在的 `system` 字段替换为配置的提示词文本：原 `system` 为字符串时替换为字符串形态，原为块数组时替换为保留原块 cache_control 的单 text 块（主动超出，经用户确认保留：请求原无 `system` 字段时不主动注入提示词，字节透传）；提示词为空字符串时覆写 SHALL 按 no-op 处理（不改写、字节透传）；开关关闭或请求不含 `system` 字段时 SHALL 不做任何改写（字节透传）。覆写行为由代理启动时读取的配置决定，设置修改对重启后的新会话生效。

#### Scenario: 开关开启时覆写字符串形态 system
- **GIVEN** 覆写已开启且配置了非空自定义提示词
- **WHEN** CC 请求的 `system` 为字符串
- **THEN** 转发请求的 `system` 为配置的提示词字符串

#### Scenario: 开关开启时覆写块数组形态 system
- **GIVEN** 覆写已开启且配置了非空自定义提示词
- **WHEN** CC 请求的 `system` 为块数组且任一块带 cache_control
- **THEN** 转发请求的 `system` 为单 text 块，文本为配置提示词
- **AND** 该 cache_control 原样保留（维持 prompt caching）

#### Scenario: 提示词为空时覆写不生效
- **GIVEN** 覆写开关已开启但配置提示词为空字符串
- **WHEN** CC 请求经代理转发
- **THEN** 请求体不做任何 system 改写（字节透传）
- **AND** 不产生空 system 的破坏性请求

#### Scenario: 开关关闭时字节透传
- **GIVEN** 覆写未开启
- **WHEN** CC 请求经代理转发
- **THEN** 请求体与现版本行为一致，不做任何 system 改写

#### Scenario: system 字段缺失不补写
- **GIVEN** 覆写已开启且配置了非空自定义提示词
- **WHEN** 请求体不含 `system` 字段
- **THEN** 请求原样转发，不新增 system 字段

### Requirement: 设置页系统提示词覆写卡片
The system SHALL 在设置页展示「系统提示词覆写」设置卡片，包含即时保存开关、预置模板下拉（至少 3 条非空模板，选择后仅填充输入框不提交）与 textarea 输入框（页面加载时从服务端权威设置回填初值）；开启开关且输入框为空时 SHALL 拉取捕获的 CC 默认系统提示词预填（无捕获数据时保持为空且不报错）；用户修改输入框失焦时 SHALL 提交保存；保存期间全部控件禁用，失败时回滚最近一次服务端权威快照并显示错误；卡片描述 SHALL 提示空提示词时覆写不生效及覆写可能影响 Claude Code 功能完整性。

#### Scenario: 首次开启自动预填
- **GIVEN** 输入框为空且代理已捕获 CC 默认系统提示词
- **WHEN** 用户开启覆写开关
- **THEN** 输入框自动填入捕获的 CC 默认系统提示词
- **AND** 填入内容随开关保存一同提交

#### Scenario: 无捕获数据时开启
- **GIVEN** 输入框为空且无捕获数据
- **WHEN** 用户开启覆写开关
- **THEN** 输入框保持为空
- **AND** 开关保存成功，不显示异常错误

#### Scenario: 模板填充不直接保存
- **WHEN** 用户在模板下拉选择一个预置模板
- **THEN** 模板内容填入输入框
- **AND** 不立即提交保存，等待用户修改后失焦保存

#### Scenario: 输入框失焦保存
- **GIVEN** 输入框内容与最近一次服务端权威快照不同
- **WHEN** 输入框失去焦点
- **THEN** 提交保存 prompt
- **AND** 保存期间卡片全部控件禁用

#### Scenario: 保存失败回滚
- **WHEN** prompt 或 enabled 保存失败
- **THEN** 卡片按最近一次服务端权威快照恢复
- **AND** 显示错误信息，设置服务保持可用
