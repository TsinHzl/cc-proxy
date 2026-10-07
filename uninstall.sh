#!/usr/bin/env bash
# cc-proxy 一键卸载：移除全局注册的 cc-proxy / claude-proxy 命令。
# 不删除 ~/.cc-proxy/ 下的配置、用量统计与日志。
set -euo pipefail
cd "$(cd "$(dirname "$0")" && pwd)"

echo "▸ 移除全局命令（npm unlink -g）…"
if npm unlink -g cc-proxy; then
    echo "✓ 已卸载 cc-proxy / claude-proxy"
else
    echo "✗ 卸载失败（可能尚未安装），可忽略或手动执行 npm unlink -g cc-proxy" >&2
    exit 1
fi

# 提示：个人数据不在卸载范围内（if 形式避免 set -e 下短路表达式误报非零退出码）
if [ -d "$HOME/.cc-proxy" ]; then
    echo "ℹ 保留个人数据目录：$HOME/.cc-proxy（如需清理请手动删除）"
fi
exit 0
