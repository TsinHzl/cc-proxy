## Purpose
cc-proxy 的设置能力：提供 `cc-proxy --setting` 交互式设置页与 `~/.cc-proxy/config.json` 持久化配置读写（容错回退）。此前承载的「思考滚动窗口」实验特性因与 Claude Code Ink 渲染器不兼容（ANSI 光标控制码导致流式输出失效）已整体退役，设置页仅保留配置展示与退出。

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
The system SHALL 在 CLI 收到 `--setting` 参数时进入交互式设置页（不启动代理与 claude），展示当前配置与落盘路径，回车/Esc 退出且不修改配置。菜单逻辑 SHALL 为可注入 stdin/stdout 的纯函数以便测试。

#### Scenario: 进入设置页
- **WHEN** 用户执行 `cc-proxy --setting`
- **THEN** 进入交互式设置页并显示当前配置状态与配置文件路径，不启动代理与 claude

#### Scenario: 退出不改配置
- **WHEN** 用户按回车/Esc 退出
- **THEN** 退出且不写配置文件
