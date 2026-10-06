## Purpose
cc-proxy 的设置能力：提供 `cc-proxy --setting` 交互式设置页与 `~/.cc-proxy/config.json` 持久化配置，当前支持「思考滚动窗口」实验特性——开启后 thinking 渲染区在终端内始终只显示最近 N 行（默认 10，可调），通过 ANSI 光标控制码原地滚动刷新，避免长思考刷屏。

## ADDED Requirements

### Requirement: 配置持久化与容错
The system SHALL 将设置持久化到 `~/.cc-proxy/config.json`，且在配置文件缺失、损坏（非法 JSON）或字段非法时回退到默认配置 `{ thinkingWindow: { enabled: false, lines: 10 } }`，不得抛出异常或中断启动。

#### Scenario: 首次使用无配置文件
- **WHEN** `~/.cc-proxy/config.json` 不存在时读取配置
- **THEN** 返回默认配置（thinkingWindow.enabled=false, lines=10），不报错
- **AND** 不自动创建配置文件（首次写入时才创建目录与文件）

#### Scenario: 配置文件损坏
- **GIVEN** `~/.cc-proxy/config.json` 内容为非法 JSON
- **WHEN** 读取配置
- **THEN** 回退默认配置，不抛出异常

#### Scenario: 行数非法回退
- **GIVEN** 配置中 thinkingWindow.lines 为 0、负数、非整数或大于 100
- **WHEN** 读取配置
- **THEN** lines 回退为默认 10，其余字段正常解析

### Requirement: --setting 交互式设置页
The system SHALL 在 CLI 收到 `--setting` 参数时进入交互式设置菜单（不启动代理与 claude），菜单至少支持：切换 thinkingWindow 开关、调整窗口行数（1-100）、退出；修改即时写回配置文件。菜单逻辑 SHALL 为可注入 stdin/stdout 的纯函数以便测试。

#### Scenario: 进入设置页
- **WHEN** 用户执行 `cc-proxy --setting`
- **THEN** 进入交互式菜单并显示当前配置状态，不启动代理与 claude

#### Scenario: 切换开关并持久化
- **GIVEN** 当前 thinkingWindow.enabled 为 false
- **WHEN** 用户在菜单中选择切换开关
- **THEN** enabled 变为 true 并写回 config.json，下次会话生效

#### Scenario: 调整行数并持久化
- **WHEN** 用户在菜单中输入 1-100 的新行数
- **THEN** thinkingWindow.lines 更新并写回 config.json；输入非法时提示重输

### Requirement: 思考滚动窗口渲染
The system SHALL 提供 thinkingWindow（默认关闭）设置项；开启后 thinking 文案渲染采用滚动窗口：前 N 行（N=thinkingWindow.lines，不含 `💭 Thinking` 头行与 `💭 Thought for Ns` 耗时行）逐行正常流式，第 N+1 行起每条新行 delta 以 `ESC[NA ESC[J` 光标控制码开头并整窗重写最近 N 行（首条重写行无 `\n` 前导，其余行 `\n<dim>text<reset>`）。关闭时渲染格式 SHALL 与现状字节一致（兼容 agy-cc-proxy）。

#### Scenario: 窗口未满正常流式
- **GIVEN** thinkingWindow 开启且 lines=3
- **WHEN** thinking 前 3 行到达
- **THEN** 逐行流式输出 `\n<dim>line<reset>`，与窗口关闭时格式一致

#### Scenario: 窗口满后整窗重写
- **GIVEN** thinkingWindow 开启且 lines=3，已有 3 行流出
- **WHEN** 第 4 行到达
- **THEN** 发出单个 delta：`ESC[3A ESC[J` + 重写最近 3 行（首行无 `\n` 前导），终端窗口内始终为最近 3 行

#### Scenario: 头行与耗时行不计入窗口
- **GIVEN** thinkingWindow 开启
- **WHEN** thinking 块开始与结束
- **THEN** `💭 Thinking` 头行与 `💭 Thought for Ns` 耗时行不占窗口行数，耗时行以 `\n<dim>…<reset>` 追加在窗口最后一行下方

#### Scenario: 窗口关闭时字节兼容
- **GIVEN** thinkingWindow 关闭（默认）
- **WHEN** thinking 渲染
- **THEN** 输出与现有实现字节一致，不包含任何 ANSI 光标控制码

#### Scenario: 多 thinking 块窗口独立
- **GIVEN** 同一响应中多个 thinking 块
- **WHEN** 各块渲染
- **THEN** 每个块的窗口行队列独立计数，互不影响

### Requirement: 滚动窗口历史剥离
The system SHALL 在窗口开启产生的渲染文本进入对话历史时完整剥离：stripThinkingTextHistory 的剥离正则 SHALL 覆盖三形态（`\n<dim>line<reset>` 常规行、无前导 `\n` 的 `<dim>line<reset>` 重写行、`\x1b[\d*A\x1b[J` 控制码序列），剥离后无控制码与文案残留。

#### Scenario: 含控制码块剥离干净
- **GIVEN** 历史消息中存在窗口开启时渲染的 text 块（含控制码与重写行）
- **WHEN** stripThinkingTextHistory 处理
- **THEN** 整块清除，无控制码残留、无文案残留

#### Scenario: 混合文本剥离
- **GIVEN** assistant 消息 text 块中滚动窗口块前后均有正常文本
- **WHEN** 剥离处理
- **THEN** 仅保留前后正常文本，中间窗口块整体清除
