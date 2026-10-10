# 项目上下文

## 技术栈
- Node.js >= 18 (ESM)，零运行时依赖（仅用 Node 内置模块 http / https / child_process）
- 包管理：npm；全局 bin 提供 `claude-proxy` / `cc-proxy` 命令

## 架构约定
- 单一职责：本地透明代理，监听 127.0.0.1 随机/固定端口，透传 Anthropic Messages API 流量到上游（ANTHROPIC_BASE_URL 或默认 https://api.anthropic.com）
- Claude Code 响应可按配置进行 SSE 与非流式 message JSON 的 thinking 文本化；非 message JSON、错误响应及不参与转换的流量原样透传
- CLI 入口：启动代理子进程 → 注入 ANTHROPIC_BASE_URL → spawn `claude` → 退出联动清理
- 代理请求管道无状态；设置服务使用仅本机 capability token，不提供账号系统

## 目录结构
```
bin/claude-proxy.js          # CLI 入口（bin 名：claude-proxy + cc-proxy）
bin/settings-web.js          # 本地 Web 设置服务、API 与浏览器启动
bin/settings-session.js      # 页面租约、定时器与 socket 关闭流程
src/proxy.js                 # HTTP 代理服务器
src/settings.js              # 配置归一化与原子写盘
src/thinking-text.js         # thinking 事件 → 文本化渲染（移植自 agy-cc-proxy）
src/upstream.js              # 上游 URL 构建
test/settings-web.test.mjs   # Web 页面、API、生命周期与浏览器测试
test/thinking-text.test.mjs  # node:test 单元测试
```

## 开发约定
- node:test 测试，`npm test` 运行
- 最小实现：不做 claude-tap 的 trace / viewer / 多客户端功能
