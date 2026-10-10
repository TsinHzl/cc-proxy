## ADDED Requirements

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
The system SHALL 在 `systemPromptOverride.enabled` 为 true 且配置的提示词非空时，将 CC 请求中已存在的 `system` 字段替换为配置的提示词文本：原 `system` 为字符串时替换为字符串形态，原为块数组时替换为保留原首块 cache_control 的单 text 块；提示词为空字符串时覆写 SHALL 按 no-op 处理（不改写、字节透传）；开关关闭或请求不含 `system` 字段时 SHALL 不做任何改写（字节透传）。

#### Scenario: 开关开启时覆写字符串形态 system
- **GIVEN** 覆写已开启且配置了非空自定义提示词
- **WHEN** CC 请求的 `system` 为字符串
- **THEN** 转发请求的 `system` 为配置的提示词字符串

#### Scenario: 开关开启时覆写块数组形态 system
- **GIVEN** 覆写已开启且配置了非空自定义提示词
- **WHEN** CC 请求的 `system` 为块数组且首块带 cache_control
- **THEN** 转发请求的 `system` 为单 text 块，文本为配置提示词
- **AND** 首块 cache_control 原样保留（维持 prompt caching）

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
