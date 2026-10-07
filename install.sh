#!/usr/bin/env bash
# cc-proxy 一键安装：检查前置要求后执行 npm link，
# 把 cc-proxy / claude-proxy 两个命令注册到全局 PATH。
set -euo pipefail
cd "$(cd "$(dirname "$0")" && pwd)"

fail() { echo "✗ $1" >&2; exit 1; }

# 前置要求 1：node ≥ 18
if ! command -v node >/dev/null 2>&1; then
    fail "未检测到 node，请先安装 Node.js ≥ 18（https://nodejs.org）"
fi
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 18 ] || fail "Node.js 版本过低（当前 $(node -v)），需要 ≥ 18"

# 前置要求 2：npm 可用
command -v npm >/dev/null 2>&1 || fail "未检测到 npm"

echo "▸ 安装依赖并注册全局命令（npm link）…"
npm link

# 验证：注册的命令实际可执行
echo "▸ 验证安装…"
if command -v cc-proxy >/dev/null 2>&1 && out="$(cc-proxy -v 2>/dev/null)"; then
    echo "✓ 安装成功：$out"
    echo "  现在可以直接使用：cc-proxy / claude-proxy"
    echo "  设置页：cc-proxy --setting"
else
    fail "cc-proxy 命令不可用，请检查 PATH 或手动执行 npm link 查看报错"
fi
