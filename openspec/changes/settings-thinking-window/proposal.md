# 变更提案：settings-thinking-window

## 背景
cc-proxy 目前的 thinking 文案逐行无限下滚，长思考会刷屏。需要一个设置功能：通过 `cc-proxy --setting` 进入交互式设置页，提供「十行思考窗口」设置项（默认关闭），开启后 thinking 渲染区始终只显示最近 N 行（默认 10，可调），采用 ANSI 光标控制码原地滚动刷新（实验特性）。

## 目标范围
**在范围内：**
- `--setting` 交互式设置页（readline 实现，零依赖），支持开关切换与行数调整
- 配置持久化到 `~/.cc-proxy/config.json`（容错：损坏/非法值回退默认）
- 滚动窗口渲染：窗口开启时，前 N 行正常流式；第 N+1 行起发送 `ESC[NA ESC[J` 控制码 + 整窗重写
- 窗口行数不含 `💭 Thinking` 头行与 `💭 Thought for Ns` 耗时行
- 历史剥离正则扩展：能完整清除含控制码的滚动窗口块
- 配置注入链路：bin 启动时读一次 → createProxyServer → transformThinkingAsTextEvents options

**不在范围内：**
- 非 Claude Code UA 流量的任何改写
- 流式原地滚动在 Claude Code Ink 渲染器下的效果保证（实验特性，需真机验证，不兼容时用户可关闭）
- 配置热重载（修改后需重开会话生效）
- 其他设置项（当前仅 thinking window 一项，结构上可扩展）

## Spec 说明
本变更引入新的用户可见行为（`--setting` CLI、配置 schema、滚动窗口渲染格式），将创建 delta spec：`openspec/changes/settings-thinking-window/specs/cc-proxy-settings/spec.md`（落地任务见 tasks.md 任务 0），覆盖配置项与默认值、容错回退、`--setting` 交互行为、窗口渲染格式（含发射布局定义）、历史剥离行为。

## 技术方案
- 新增 `src/settings.js`：readConfig/writeConfig（默认 `{ thinkingWindow: { enabled: false, lines: 10 } }`，损坏回退默认），行数校验 1-100 整数；**路径可注入**（默认 `~/.cc-proxy/config.json`，测试传临时目录，避免读写真实配置）
- 新增 `bin/settings-cli.js`：交互式菜单，菜单逻辑抽为可注入 stdin/stdout 的纯函数（node:test 可测），CLI 壳仅做装配
- `transformThinkingAsTextEvents` options 增加 `windowLines`（0/undefined=关闭）
- **窗口发射布局（实现/测试/剥离正则三方对齐的唯一事实）**：
  - 窗口未满：与现状一致，`\n<dim>line<reset>` 逐行流式
  - 窗口已满、新行到达：单个 delta = `ESC[NA ESC[J` + 整窗重写（`<dim>L1<reset>` 首行无 `\n` 前导——光标已在行首；其余行 `\n<dim>Li<reset>`）
  - stop 路径：tail 半行与耗时行同样应用窗口逻辑；耗时行恒为 `\n<dim>💭 Thought for Ns<reset>` 追加在窗口下方，不占窗口行数
  - `emittedLines` 队列按 thinking 块重置（多个块互不影响）
- 历史剥离：`THINKING_TEXT_BLOCK_RE` 扩展为三交替分支（`\n<dim>line<reset>` | 无前导 `<dim>line<reset>` | `\x1b[\d*A\x1b[J`）；该正则形态已在本仓 node 环境对样例文本验证可完整清除（独立行/内联/多次滚动/耗时行/混合文本），实现后由任务 3 单测固化
- 字节上限：控制码每行约 8B，远低于 256KB/1MiB 上限，无需调整
- **字节兼容不变量范围声明**：窗口关闭（默认）时渲染字节兼容 agy-cc-proxy；窗口开启为本仓扩展特性，不要求字节兼容（config.yaml 不变量描述将随归档更新）

## 预期影响
- 对现有行为零影响：窗口默认关闭，`windowLines` 为 0 时所有新分支短路，25 项现有测试不变
- 开启后：长思考不再刷屏，但历史消息中控制码依赖扩展剥离正则清除（实现后由任务 3 单测验证）
- 实验风险：CC 的 Ink 渲染器对 SSE 文本流中 ANSI 光标控制码的渲染未经验证，可能错位/花屏；失败时关闭设置即可回退

## 风险
1. **Ink 渲染器兼容性（高）** — 控制码可能被 CC 吞掉或显示乱码；应对：标记实验特性、默认关闭、README 注明
2. **历史剥离遗漏（中）** — 控制码形态若超出预期（如 CC 端二次包装）会残留 token 垃圾；应对：剥离正则按本实现的确定性格式编写，已覆盖独立行与内联形态
3. **配置损坏（低）** — 手工编辑 config.json 出错；应对：parse 失败回退默认值
