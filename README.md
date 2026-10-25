<p align="center">
  <b>简体中文</b> | <a href="README.en.md">English</a>
</p>

# cc-proxy

claude code 本地代理：让直连 Anthropic API / 任意第三方网关的 Claude Code 会话，
也能展示深度思考文案（`> 💭 Thinking` 灰色引文流式渲染，移植自 agy-cc-proxy）。

![Thinking 渲染效果](docs/screenshot-thinking.png)

## 安装

前置要求：

- Node.js ≥ 18
- 已安装 Claude Code CLI（`claude` 命令可用）

```bash
git clone https://github.com/TsinHzl/cc-proxy.git cc-proxy && cd cc-proxy
npm link          # 把 claude-proxy / cc-proxy 两个命令注册到全局 PATH
```

免 clone 直装（npm 拉取 GitHub master 全局安装，更新时重跑同一命令）：

```bash
npm install -g github:TsinHzl/cc-proxy
```

验证：

```bash
claude-proxy --version    # 输出代理自身版本号（如 claude-proxy 1.0.0）即安装成功
```

更新：

安装方式为 `npm link`（软链到本仓库目录），更新代码后无需重新注册：

```bash
cd cc-proxy
git pull          # 拉取最新代码，立即生效
```

> 若上游发布的版本有结构变化，拉取后可再执行一次 `npm link` 兜底。

卸载：

```bash
npm unlink -g cc-proxy
```

> 不想全局注册时，可直接 `node bin/claude-proxy.js` 运行，效果一致。

## 使用

```bash
cc-proxy                    # 起代理并进入交互式 Claude Code
claude-proxy                # 等价命令
cc-proxy -v                 # 查看代理版本号后退出
cc-proxy -c                 # 参数原样透传给 claude（此处为 --continue）
cc-proxy -p "解释这段代码"    # 非交互模式同样可用
```

命令行为：

1. 在 127.0.0.1 起一个本地透明代理（随机可用端口）
2. 注入 `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` 后 spawn `claude`（全部参数/stdio 透传）
3. claude 退出后代理随之退出（退出码透传），并在 stderr 打印本次会话用量总结
   （请求数 / 输入 / 输出 / 缓存读写 tokens / 缓存命中率，需 `CC_PROXY_LOG=1` 查看）

### 指定上游

代理把请求转发到**启动它时**的 `ANTHROPIC_BASE_URL`；未设置则用官方 `https://api.anthropic.com`。

```bash
# 官方 API
cc-proxy

# 第三方网关（base URL 的路径前缀会原样拼接）
ANTHROPIC_BASE_URL=https://gw.example.com/api cc-proxy
```

> 代理会先把该变量保存为转发目标，再替换为本地地址传给 claude，因此原有配置不会丢失。

### 多上游故障转移

在 `~/.cc-proxy/config.json` 中配置 `upstreams` 数组可启用备用上游（启动时读取一次并固定）：

```json
{
  "upstreams": [
    { "name": "backup-a", "baseUrl": "https://gw-a.example.com/api", "headers": { "x-api-key": "sk-a" } },
    { "name": "backup-b", "baseUrl": "https://gw-b.example.com" }
  ]
}
```

请求按顺序转发：主上游（`ANTHROPIC_BASE_URL`）→ `upstreams` 数组各项。主上游对
502/503/529 做同上游重试（1s/2s/4s）耗尽，或遇到 429/500（立即切换）、连接级失败
（同上游重试耗尽）后，切到下一个备用上游，并合并该项 `headers`（如各自的 API
key）。全部上游失败时，客户端收到最后一个错误响应。`name` 缺省取 host；
`baseUrl` 路径前缀拼接规则与主上游一致。

> `headers` 中的密钥仅保存在 `~/.cc-proxy/config.json`（文件权限 0600），不打印
> 到日志。启动横幅与切换事件通过 `CC_PROXY_LOG=1` 可见，默认静默。未配置
> `upstreams` 时行为与现状完全一致。

熔断保护：某上游连续失败 ≥3 次后进入 `open`（选路跳过，设置页显示「熔断中」徽标
及剩余冷却秒数），30s 冷却后下一个请求作为 `half-open` 探测放行——成功则恢复、
失败则重新熔断。全部上游均熔断时忽略熔断按原顺序尝试（熔断不是最终否决）。

### 渲染效果

仅当客户端 UA 匹配 `claude-cli` / `claude-code` 时生效，thinking 块会被改写为：

```
💭 Thinking
逐行的思考内容（暗色显示）
```

其他客户端（curl、各语言 SDK 等）流量原样透传，不做任何改写。

多轮对话中，历史消息里已渲染的思考文本会在转发前剥离，避免上下文膨胀。

### 设置页

```bash
cc-proxy --setting
```

启动仅监听 `127.0.0.1` 的临时 Web 设置服务，并自动打开默认浏览器。页面包含以下五个开关：

- `Suggestion Mode 输入建议转发`：默认关闭；开启后把输入建议请求转发上游并额外消耗 token。
- `思考内容文本化展示`：默认开启；关闭后恢复 Claude Code 原生折叠 Thinking 块。
- `Effort 覆写`：默认开启（high）；开启后所有请求均以所选档位转发，可配置目标上游列表仅对特定上游生效（详见下方小节）。
- `系统提示词覆写`：默认关闭；开启后所有请求的 system 提示词被替换为输入框内容。
- `用量展示缩放`：默认关闭；开启后按比例缩放返回给 Claude Code 的上下文用量（详见下方小节）。

五个开关会即时、原子地写入 `~/.cc-proxy/config.json`，并对下次启动的代理会话生效。新配置文件权限为 `0600`；更新已有配置时保留原权限。页面在初始化和保存期间禁用全部控件，保存成功后采用服务端返回的完整设置，失败时回滚到最近一次服务端权威状态。

#### 系统提示词覆写

开启后，代理把所有 Claude Code 请求中的 `system` 字段替换为输入框里的自定义提示词（默认关闭时字节透传，与原行为一致）。要点：

- **预填**：首次开启且输入框为空时，页面自动拉取代理从真实请求捕获的 CC 默认系统提示词（落盘 `~/.cc-proxy/captured-system-prompt.json`，始终记录覆写前的原始值）作为起点；无捕获数据时保持为空，不报错。
- **模板**：下拉提供「营销文案 / 写作助手 / 产品经理 / 数据分析师 / 翻译专家」五条预置角色模板（均为完整结构：角色定义 + 行为准则 + 工作流程 + 输出规范 + 会话指引，含细分场景规则、输出格式约定与禁区约束），选择后仅填入输入框，修改后失焦保存。
- **空提示词不生效**：`enabled` 为 true 但提示词为空时覆写按 no-op 处理，不会产生空 system 的破坏性请求。
- **原无 system 不补写**：请求体不含 `system` 字段时按字节透传，不主动注入提示词。
- **功能完整性警示**：CC 内置工具/技能说明依赖系统提示词，覆写后可能失效，请自行评估。
- 提示词上限 256KB（UTF-8 字节），设置 API 正文上限相应为 320KB。

#### Effort 覆写

```json
{
  "effortOverride": {
    "enabled": true,
    "level": "high",
    "baseUrls": ["https://gateway.example.com/api"]
  }
}
```

Claude Code 会按本地设置发送 effort 档位（`output_config.effort`，并兜底 top-level `effort`）。开启覆写后，代理在转发前把这些字段统一改写为配置档位，无论 CC 本地设置是什么。要点：

- **默认开启且为 high**：出厂即为 `enabled: true` / `level: high`，即未配置也统一以 high 转发；关闭后按字节透传，恢复 CC 本地档位。
- **档位可选**：`low` / `medium` / `high` / `xhigh` / `max` / `ultracode`；非法值回退 `high`。
- **定向覆写（`baseUrls`）**：默认 `[]`，此时开启即对**所有**上游覆写。配置非空列表后，仅当本请求**将要命中的上游**完整 base URL 匹配列表项时该上游收到覆写后的请求体，其余上游按未覆写的请求体转发（等效覆写关闭）。匹配规则与「用量展示缩放」完全一致：协议 + host + 端口（缺省端口按 http→80 / https→443 归一）须完全一致，路径按**段前缀**匹配（配置 `/api` 命中 `/api` 与 `/api/x`，不命中 `/apiv2`；配置空路径覆盖该 origin 全部路径）；尾斜杠自动归一。多上游故障转移时**按每个候选上游逐个判定**：切换到命中列表的上游即收到覆写体，切换到未命中的上游则收到原始体。设置页「Effort 覆写」区块提供目标上游动态列表（添加 / 删除 / 失焦保存），非法 URL 本地拦截不提交。
- **仅影响 Claude Code 请求**：非 CC 客户端、非 JSON body 一律原样透传。
- **重启生效**：配置在代理启动时读取一次，切换后需下次会话生效。
- **配置容错**：手改 `config.json` 时 `baseUrls` 非法项（不可解析或非 http/https）逐项丢弃；若**全部**项均非法，列表退化为空 → 等效全量覆写，请留意。

#### 用量展示缩放

```json
{
  "usageScale": {
    "enabled": true,
    "ratio": 0.5,
    "baseUrls": ["https://gateway.example.com/api"]
  }
}
```

Claude Code 按返回的 usage 计数计算 Ctx%（上下文占用百分比），并在约 82% 时触发 auto-compact。部分第三方网关的计数口径与 CC 预期不同，导致显示偏差或压缩时机不合预期。

开启后，代理按 `ratio` 缩放返回给 Claude Code 的 usage **input 类字段**（`input_tokens`、`cache_creation_input_tokens`、`cache_read_input_tokens` 及 `cache_creation.ephemeral_*`；向上取整），`output_tokens` 不缩放（避免影响输出长度计算）。要点：

- **默认关闭**：关闭时维持「上游是多少就是多少」的 1:1 透传，行为与原版完全一致。`ratio` 缺省为 `1.0`（等效不缩放），可省略。
- **比例可自定义**：有限数 (0, 10]，既可缩小（如 `0.5`，延后 auto-compact）也可放大（如 `2`，提前触发）。
- **定向缩放（`baseUrls`）**：默认 `[]`，此时开启即对**所有**上游缩放。配置非空列表后，仅当本请求**实际命中的上游**完整 base URL 匹配列表项时才缩放，其余上游 1:1 透传。匹配规则：协议 + host + 端口（缺省端口按 http→80 / https→443 归一）须完全一致，路径按**段前缀**匹配（配置 `/api` 命中 `/api` 与 `/api/x`，不命中 `/apiv2`；配置空路径覆盖该 origin 全部路径）；尾斜杠自动归一。多上游故障转移时按最终响应的上游判定。设置页「用量展示缩放」区块提供目标上游动态列表（添加 / 删除 / 失焦保存），非法 URL 本地拦截不提交。
- **仅影响 CC 客户端可见值**：内部用量统计（`usage.json`）与设置页看板始终记录上游真实值；非 Claude Code 客户端、错误响应、非 message JSON 一律原样透传。
- **重启生效**：配置在代理启动时读取一次，切换开关后需下次会话生效。
- **配置容错**：手改 `config.json` 时 `baseUrls` 非法项（不可解析或非 http/https）逐项丢弃；若**全部**项均非法，列表退化为空 → 等效全量缩放，请留意。

终端和浏览器只显示不含凭据的基础 URL：

```text
http://127.0.0.1:<port>/
```

每次加载页面都会获得一个 30 秒有效、仅可兑换一次的 Bootstrap nonce；页面通过同源请求兑换临时 API token，token 不进入 URL、终端输出或 Referer。未消费 nonce 最多保留 256 个，超限时淘汰最旧项。

设置 API 仅接受不超过 320KB（327680 字节）的 JSON 正文，并对正文读取使用 5 秒绝对超时。最后一个设置页关闭后，服务等待 2 秒自动退出；宽限期内刷新并重新建立租约会取消退出。浏览器在 30 秒内未连接时，服务也会自动退出。关闭阶段若连接未在 1 秒内结束，服务会销毁残留 socket 并释放端口。浏览器未自动打开时，可手动访问终端输出的本地 URL。配置文件缺失或损坏时自动回退默认值，不影响启动。

### Suggestion Mode 输入建议

Claude Code 会在主对话之外发送以 `[SUGGESTION MODE` 开头的输入建议请求（额外消耗 token）。本代理默认**拦截**这类请求并返回结构完整的空响应（流式/非流式自适应），主对话不受影响，`usage.json` 与 debug 日志零增量；非 Claude Code 客户端流量不受任何影响。

在 Web 设置页切换转发开关后会立即写盘；保存失败时页面恢复原状态并显示错误，设置服务保持可用。

开启后建议请求正常转发上游（Claude Code 会展示输入建议，但会产生额外计费）。开关持久化于 `~/.cc-proxy/config.json` 的 `forwardSuggestionMode` 字段，**切换后对下次启动的会话生效**（已运行的代理在启动时读取一次配置）。

### 用量统计

代理自动从响应（SSE `message_start`/`message_delta` 或非流式 JSON）中提取 token 用量，按天累计持久化到 `~/.cc-proxy/usage.json`：

```json
{
  "2026-10-07": {
    "requests": 42,
    "inputTokens": 123456,
    "outputTokens": 5678,
    "cacheReadTokens": 89012,
    "cacheCreationTokens": 1234,
    "byModel": {
      "claude-sonnet-5": { "requests": 40, "inputTokens": 120000, "outputTokens": 5400, "cacheReadTokens": 88000, "cacheCreationTokens": 1200 }
    }
  }
}
```

文件缺失或损坏时自动回退空统计，落盘失败不阻塞代理流量。`claude` 退出时会把本次会话的当日累计总结打印到 stderr（需 `CC_PROXY_LOG=1`）。

### 用量看板与告警

```bash
cc-proxy --setting
```

设置页展示近 7 天用量看板：每日柱状图、按模型分组统计、缓存命中率与估算费用（`GET /api/usage`）。数据来自 `usage.json` 的 `byModel` 按模型分组累计（模型缺失时归入 `unknown`）。

- **缓存命中率**：`cacheRead / (cacheRead + cacheCreation + input)`，无请求时分母为 0，显示为 `n/a`。
- **费用估算**：内置 claude-opus-5 / claude-sonnet-5 / claude-haiku-4-5 默认价表（USD / 每百万 token），日期后缀变体（如 `claude-sonnet-5-2026xxxx`）按最长前缀匹配命中；未收录模型不显示费用。
- **价表覆盖**：在 `~/.cc-proxy/config.json` 中配置 `models.<model>.pricing = { input, output, cacheRead, cacheCreation }` 即可覆盖内置价表（支持前缀键），精确键优先于前缀匹配。
- **当日用量告警**：配置 `alerts.dailyTokens`（正整数）后，当日 tokens（输入 + 输出 + 缓存读写）超过阈值时，CLI 启动横幅前打印一条 WARNING，设置页看板出现红点；未配置（0）时零提示。

```json
{
  "alerts": { "dailyTokens": 5000000 },
  "models": {
    "my-model-v2": { "pricing": { "input": 2, "output": 10, "cacheRead": 0.2, "cacheCreation": 2.5 } }
  }
}
```

### Debug 请求日志

```bash
CC_PROXY_DEBUG=1 cc-proxy
```

设置 `CC_PROXY_DEBUG=1` 后，每个请求的 method/url/status/耗时、请求体与 SSE 事件流逐条落盘到 `~/.cc-proxy/logs/`（每请求一个 `.log` 文件），用于排查第三方网关兼容性：

- header 只记录名称，值（authorization、api key 等）不落盘
- 写失败静默丢弃，绝不影响代理流量
- 未设置时零开销、零文件

## 开发

```bash
npm test        # node:test 单元 + 端到端测试
```

## 目录结构

| 路径 | 说明 |
|---|---|
| `bin/claude-proxy.js` | CLI 入口：--version / --setting / 起代理 → 注入 env → spawn claude |
| `bin/settings-web.js` | `--setting` 本地 Web 页面、受保护 API 与浏览器启动 |
| `bin/settings-session.js` | 设置页 SSE 租约、定时器、socket 跟踪与关闭流程 |
| `bin/settings-cli.js` | 旧终端设置菜单实现（当前 CLI 不再调用） |
| `src/thinking-text.js` | 渲染核心：格式化、流式改写、历史剥离、UA 门控 |
| `src/proxy.js` | HTTP 代理与响应改写（SSE / 非流式 JSON）、Suggestion Mode 拦截、usage/debug 挂接 |
| `src/upstream.js` | 上游地址解析与请求转发 |
| `src/upstream-breaker.js` | 上游熔断器（连续失败≥3 → open → 30s 冷却 → half-open 探测恢复），供选路过滤与设置页徽标 |
| `src/settings.js` | 配置读写（`~/.cc-proxy/config.json`），缺失/损坏回退默认值 |
| `src/suggestion-mode.js` | 建议请求识别与空响应构建（流式/非流式） |
| `src/usage.js` | 用量提取与按天持久化（`~/.cc-proxy/usage.json`），含 byModel 按模型分组 |
| `src/pricing.js` | 模型定价与费用估算（内置价表 + config 覆盖 + 前缀匹配）、缓存命中率 |
| `src/debug-log.js` | 请求级 debug 日志（`CC_PROXY_DEBUG=1`） |
| `test/*.test.mjs` | 单元与端到端测试（node:test） |
