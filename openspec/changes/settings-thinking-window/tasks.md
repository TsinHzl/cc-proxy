# 任务清单：settings-thinking-window

## 状态：IN_PROGRESS

## 任务
- [ ] 1. src/settings.js：readConfig/writeConfig + 默认值/容错/行数校验（node:test 单测：默认回退、非法 lines 回退 10、merge 写回）
- [ ] 2. transformThinkingAsTextEvents 增加 windowLines 选项：flushCompleteLines 维护 emittedLines 队列（按块重置）；窗口满时单 delta 整窗重写（`ESC[NA ESC[J` + 首行无 `\n` 前导 + 其余 `\n` 分隔）；**stop 路径 tail/耗时行同样应用窗口逻辑**（pending 非空、pending 空、discarded 三种形态单测）；头行/耗时行不计入窗口
- [ ] 3. stripThinkingTextHistory 剥离正则扩展为三交替分支（`\n<dim>行` | 无前导 `<dim>行` | 控制码序列）；单测按真实发射布局构造：含控制码块、含耗时行块、混合文本、多次滚动四场景剥离干净
- [ ] 4. proxy.js / bin/claude-proxy.js 注入链路：bin 启动读配置 → createProxyServer({ windowLines }) → transform options；--setting 参数分流进设置页
- [ ] 5. bin/settings-cli.js 交互式设置页：菜单逻辑抽为可注入 stdin/stdout 的纯函数（node:test 可测），CLI 壳装配；e2e 冒烟：`--setting` 管道喂入选择序列，断言 config.json 落盘值
- [ ] 6. README / README.en 补充 --setting 用法与实验特性说明；全量 npm test 通过

## 验收标准
- [ ] `cc-proxy --setting` 可进入交互菜单，修改后 `~/.cc-proxy/config.json` 持久化，损坏配置回退默认
- [ ] 窗口关闭时行为与现状完全一致（现有 25 测试不变通过）
- [ ] 窗口开启（N=10）时：前 10 行正常流式，第 11 行起单 delta 整窗重写，终端窗口内始终为最近 10 行；`💭 Thinking` 与 `Thought for Ns` 不占窗口行数（耗时行追加在窗口下方）
- [ ] 含控制码的渲染历史经 stripThinkingTextHistory 剥离后无残留（覆盖独立行/内联/多次滚动/耗时行/混合文本五场景）
- [ ] `npm test` 全量通过（现有 25 + 新增 ≥ 10）
