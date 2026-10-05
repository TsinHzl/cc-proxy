# cc-proxy

claude code 本地代理：让直连 Anthropic API / 任意第三方网关的 Claude Code 会话，
也能展示深度思考文案（`> 💭 Thinking` 灰色引文流式渲染，移植自 agy-cc-proxy）。

## 用法

```bash
claude-proxy            # 等价于 cc-proxy
cc-proxy -c             # 参数原样透传给 claude
```

命令行为：
1. 在 127.0.0.1 起一个本地透明代理（随机可用端口）
2. 注入 `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` 后 spawn `claude`（全部参数/stdio 透传）
3. claude 退出后代理随之退出（退出码透传）

上游地址：读取 `ANTHROPIC_BASE_URL`（原值会先被保存再用作转发目标），未设置时默认
`https://api.anthropic.com`。

仅对 Claude Code 客户端（UA `claude-cli`/`claude-code`）做 thinking 文本化渲染；
其他客户端流量原样透传。

## 开发

```bash
npm test    # node:test 单元测试
```
