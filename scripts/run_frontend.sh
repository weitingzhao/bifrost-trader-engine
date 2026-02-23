#!/usr/bin/env bash
# Bifrost 监控前端：开发 / 构建 统一入口（在项目根目录执行）
#
# 使用方式:
#   ./scripts/run_frontend.sh dev    # 开发模式，端口从 config/config.yaml frontend.port 读取，启动前会 Kill 占用端口的进程
#   ./scripts/run_frontend.sh build  # 生产构建，输出到 frontend/dist
#   ./scripts/run_frontend.sh install # 仅安装依赖（首次或 package.json 变更后）
#
# 何时用 dev：日常改 React/样式、调试，需要状态服务在 8765 端口运行。
# 何时用 build：部署前或给状态服务提供静态资源，构建后访问 http://localhost:8765/ 即为 React 页。

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND_DIR="$PROJECT_ROOT/frontend"
CONFIG_FILE="$PROJECT_ROOT/config/config.yaml"

# 从 config/config.yaml 读取 frontend.port，默认 5173
get_frontend_port() {
  local py
  if [[ -x "$PROJECT_ROOT/.venv/bin/python" ]]; then
    py="$PROJECT_ROOT/.venv/bin/python"
  else
    py="python3"
  fi
  "$py" -c "
import sys
sys.path.insert(0, '$PROJECT_ROOT')
try:
    import yaml
except ImportError:
    print(5173)
    sys.exit(0)
p = '$CONFIG_FILE'
import os
if not os.path.isfile(p):
    print(5173)
    sys.exit(0)
with open(p, encoding='utf-8') as f:
    c = yaml.safe_load(f) or {}
print(c.get('frontend', {}).get('port', 5173))
" 2>/dev/null || echo "5173"
}

# 杀掉占用指定端口的进程（macOS/Linux: lsof）
kill_port() {
  local port="$1"
  local pids
  pids=$(lsof -i ":$port" -t 2>/dev/null) || true
  if [[ -n "$pids" ]]; then
    echo "正在终止占用端口 $port 的进程: $pids"
    echo "$pids" | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
}

cmd="${1:-}"
case "$cmd" in
  dev)
    FRONTEND_PORT=$(get_frontend_port)
    echo "前端开发端口: $FRONTEND_PORT（来自 config/config.yaml frontend.port）"
    kill_port "$FRONTEND_PORT"
    cd "$FRONTEND_DIR"
    if [[ ! -d node_modules ]]; then
      echo "未检测到 node_modules，先执行 npm install..."
      npm install
    fi
    exec npm run dev -- --port "$FRONTEND_PORT"
    ;;
  build)
    cd "$FRONTEND_DIR"
    if [[ ! -d node_modules ]]; then
      echo "未检测到 node_modules，先执行 npm install..."
      npm install
    fi
    npm run build
    echo "构建完成：$FRONTEND_DIR/dist"
    ;;
  install)
    cd "$FRONTEND_DIR"
    npm install
    echo "依赖安装完成。"
    ;;
  *)
    echo "用法: $0 <dev|build|install>"
    echo ""
    echo "  dev     - 启动开发服务器（端口见 config/config.yaml frontend.port，默认 5173）"
    echo "  build   - 生产构建到 frontend/dist，供状态服务或静态部署使用"
    echo "  install - 仅安装 npm 依赖"
    exit 1
    ;;
esac
