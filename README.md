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
cc-proxy --version    # 输出 Claude Code 版本号（如 2.1.231 (Claude Code)）即安装成功
```

卸载：

```bash
npm unlink -g cc-proxy
```

> 不想全局注册时，可直接 `node bin/claude-proxy.js` 运行，效果一致。

## 使用

```bash
cc-proxy                    # 起代理并进入交互式 Claude Code
claude-proxy                # 等价命令
cc-proxy -c                 # 参数原样透传给 claude（此处为 --continue）
cc-proxy -p "解释这段代码"    # 非交互模式同样可用
```

命令行为：

1. 在 127.0.0.1 起一个本地透明代理（随机可用端口）
2. 注入 `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` 后 spawn `claude`（全部参数/stdio 透传）
3. claude 退出后代理随之退出（退出码透传）

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
> 💭 Thinking
> 逐行的思考内容（暗色显示）
```

其他客户端（curl、各语言 SDK 等）流量原样透传，不做任何改写。

多轮对话中，历史消息里已渲染的思考文本会在转发前剥离，避免上下文膨胀。

## 开发

```bash
npm test        # node:test 单元 + 端到端测试（24 项）
```

## 目录结构

| 路径 | 说明 |
|---|---|
| `bin/claude-proxy.js` | CLI 入口：起代理 → 注入 env → spawn claude |
| `src/thinking-text.js` | 渲染核心：格式化、流式改写、历史剥离、UA 门控 |
| `src/proxy.js` | HTTP 代理与响应改写（SSE / 非流式 JSON） |
| `src/upstream.js` | 上游地址解析与请求转发 |
| `test/thinking-text.test.mjs` | 单元与端到端测试 |
