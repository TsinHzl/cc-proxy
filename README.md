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
git clone <repo-url> cc-proxy && cd cc-proxy
npm link          # 把 claude-proxy / cc-proxy 两个命令注册到全局 PATH
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
   （请求数 / 输入 / 输出 / 缓存读写 tokens，需 `CC_PROXY_LOG=1` 查看）

### 指定上游

代理把请求转发到**启动它时**的 `ANTHROPIC_BASE_URL`；未设置则用官方 `https://api.anthropic.com`。

```bash
# 官方 API
cc-proxy

# 第三方网关（base URL 的路径前缀会原样拼接）
ANTHROPIC_BASE_URL=https://gw.example.com/api cc-proxy
```

> 代理会先把该变量保存为转发目标，再替换为本地地址传给 claude，因此原有配置不会丢失。

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

启动仅监听 `127.0.0.1` 的临时 Web 设置服务，并自动打开默认浏览器。页面只包含以下两个开关：

- `Suggestion Mode 输入建议转发`：默认关闭；开启后把输入建议请求转发上游并额外消耗 token。
- `思考内容文本化展示`：默认开启；关闭后恢复 Claude Code 原生折叠 Thinking 块。

两个开关会即时、原子地写入 `~/.cc-proxy/config.json`，并对下次启动的代理会话生效。新配置文件权限为 `0600`；更新已有配置时保留原权限。页面在初始化和保存期间禁用两个开关，保存成功后采用服务端返回的完整设置，失败时回滚到最近一次服务端权威状态。

终端和浏览器只显示不含凭据的基础 URL：

```text
http://127.0.0.1:<port>/
```

每次加载页面都会获得一个 30 秒有效、仅可兑换一次的 Bootstrap nonce；页面通过同源请求兑换临时 API token，token 不进入 URL、终端输出或 Referer。未消费 nonce 最多保留 256 个，超限时淘汰最旧项。

设置 API 仅接受不超过 1024 字节的 JSON 正文，并对正文读取使用 5 秒绝对超时。最后一个设置页关闭后，服务等待 2 秒自动退出；宽限期内刷新并重新建立租约会取消退出。浏览器在 30 秒内未连接时，服务也会自动退出。关闭阶段若连接未在 1 秒内结束，服务会销毁残留 socket 并释放端口。浏览器未自动打开时，可手动访问终端输出的本地 URL。配置文件缺失或损坏时自动回退默认值，不影响启动。

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
    "cacheCreationTokens": 1234
  }
}
```

文件缺失或损坏时自动回退空统计，落盘失败不阻塞代理流量。`claude` 退出时会把本次会话的当日累计总结打印到 stderr（需 `CC_PROXY_LOG=1`）。

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
| `src/settings.js` | 配置读写（`~/.cc-proxy/config.json`），缺失/损坏回退默认值 |
| `src/suggestion-mode.js` | 建议请求识别与空响应构建（流式/非流式） |
| `src/usage.js` | 用量提取与按天持久化（`~/.cc-proxy/usage.json`） |
| `src/debug-log.js` | 请求级 debug 日志（`CC_PROXY_DEBUG=1`） |
| `test/*.test.mjs` | 单元与端到端测试（node:test） |
