#!/bin/bash
# ============================================================
# Downie Enhanced - 本机（macOS）部署脚本
#
#   ./run-local.sh            后台启动服务并打开浏览器
#   ./run-local.sh run        前台运行（Ctrl+C 停止）
#   ./run-local.sh stop       停止后台服务
#   ./run-local.sh restart    重启
#   ./run-local.sh status     查看运行状态
#   ./run-local.sh logs       实时查看日志
#   ./run-local.sh rebuild    重新构建前端后重启
#
# 可选参数: --port 8000  --host 127.0.0.1  --lan  --no-open
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT/backend"
FRONTEND_DIR="$ROOT/frontend"
VENV="$ROOT/.venv"
RUN_DIR="$ROOT/.run"
PID_FILE="$RUN_DIR/downie.pid"
LOG_FILE="$RUN_DIR/downie.log"

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8000}"
OPEN_BROWSER=1
FORCE_BUILD=0
COMMAND=""

# ---------- 参数解析 ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    start|run|stop|restart|status|logs|rebuild)
      COMMAND="$1"; shift ;;
    --port) PORT="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --lan) HOST="0.0.0.0"; shift ;;
    --no-open) OPEN_BROWSER=0; shift ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done
COMMAND="${COMMAND:-start}"
[[ "$COMMAND" == "rebuild" ]] && { COMMAND="start"; FORCE_BUILD=1; }

# ---------- 工具函数 ----------
info()  { printf "\033[1;34m[downie]\033[0m %s\n" "$*"; }
ok()    { printf "\033[1;32m[downie]\033[0m %s\n" "$*"; }
warn()  { printf "\033[1;33m[downie]\033[0m %s\n" "$*"; }
fail()  { printf "\033[1;31m[downie]\033[0m %s\n" "$*" >&2; exit 1; }

url() { echo "http://127.0.0.1:$PORT"; }

open_url() {
  [[ "$OPEN_BROWSER" -eq 1 ]] || return 0
  local target="$1"
  if command -v open >/dev/null 2>&1; then
    open "$target" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$target" >/dev/null 2>&1 || true
  else
    info "未找到 open/xdg-open，跳过自动打开浏览器: $target"
  fi
}

health_ok() {
  curl -fsS -m 2 "$(url)/api/health" >/dev/null 2>&1
}

is_running() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

port_busy() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
  else
    return 1
  fi
}

python_bin() {
  if [[ -x "$VENV/bin/python" ]]; then echo "$VENV/bin/python"; return; fi
  if command -v python3.12 >/dev/null 2>&1; then echo "$(command -v python3.12)"; return; fi
  if command -v python3 >/dev/null 2>&1; then echo "$(command -v python3)"; return; fi
  fail "找不到 Python 3，请安装 Python 3.10+（macOS: brew install python@3.12；Linux: sudo apt install python3 python3-venv）"
}

ensure_backend() {
  mkdir -p "$RUN_DIR"
  if [[ ! -x "$VENV/bin/python" ]]; then
    info "创建 Python 虚拟环境 .venv ..."
    "$(python_bin)" -m venv "$VENV"
  fi
  if ! "$VENV/bin/python" -c "import fastapi, uvicorn, yt_dlp" >/dev/null 2>&1; then
    info "安装后端依赖（首次运行需要几分钟）..."
    "$VENV/bin/python" -m pip install -q -U pip
    "$VENV/bin/python" -m pip install -q -r "$BACKEND_DIR/requirements.txt"
  fi
  if ! command -v ffmpeg >/dev/null 2>&1 && [[ ! -x /opt/homebrew/bin/ffmpeg ]]; then
    warn "未检测到 ffmpeg，HLS / 音视频合并会失败。macOS: brew install ffmpeg；Linux: sudo apt install ffmpeg"
  fi
  if ! command -v ffprobe >/dev/null 2>&1 && [[ ! -x /opt/homebrew/bin/ffprobe ]]; then
    warn "未检测到 ffprobe，视频时长/音轨检测可能不可用。请安装完整的 ffmpeg 包。"
  fi
}

ensure_frontend() {
  local need_build=0
  [[ "$FORCE_BUILD" -eq 1 || ! -f "$FRONTEND_DIR/build/index.html" ]] && need_build=1
  [[ "$need_build" -eq 0 ]] && return

  if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
    info "安装前端依赖（npm ci）..."
    if ! ( cd "$FRONTEND_DIR" && npm ci --no-audit --no-fund ); then
      warn "npm ci 失败，改用 npm install 重试..."
      ( cd "$FRONTEND_DIR" && npm install --no-audit --no-fund )
    fi
  fi
  info "构建前端（PUBLIC_URL=/ REACT_APP_API_URL=/api）..."
  ( cd "$FRONTEND_DIR" && PUBLIC_URL=/ REACT_APP_API_URL=/api CI=false npm run build )
}

wait_health() {
  local i
  for i in $(seq 1 40); do
    if health_ok; then return 0; fi
    sleep 0.5
  done
  return 1
}

# ---------- 命令实现 ----------
do_build() {
  ensure_backend
  ensure_frontend
}

do_start_bg() {
  if is_running; then
    if health_ok; then
      ok "服务已在运行: $(url)  (PID $(cat "$PID_FILE"))"
      open_url "$(url)"
      return 0
    fi
    warn "PID 文件存在但服务无响应，重新启动..."
    do_stop || true
  fi

  if port_busy; then
    fail "端口 $PORT 已被占用，请换端口: ./run-local.sh --port 8010"
  fi

  do_build
  info "启动后端服务 ..."
  (
    cd "$BACKEND_DIR"
    nohup "$VENV/bin/python" -m uvicorn main:app --host "$HOST" --port "$PORT" \
      >>"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
  )

  if wait_health; then
    ok "启动成功: $(url)"
    ok "下载目录: $BACKEND_DIR/downloads"
    info "日志: $LOG_FILE"
    open_url "$(url)"
  else
    warn "服务未在预期时间内就绪，最近日志："
    tail -n 30 "$LOG_FILE" || true
    fail "启动失败"
  fi
}

do_run_fg() {
  is_running && fail "后台服务已在运行（PID $(cat "$PID_FILE")），请先 ./run-local.sh stop"
  port_busy && fail "端口 $PORT 已被占用"
  do_build
  info "前台启动，按 Ctrl+C 停止：$(url)"
  cd "$BACKEND_DIR"
  exec "$VENV/bin/python" -m uvicorn main:app --host "$HOST" --port "$PORT"
}

do_stop() {
  if ! is_running; then
    rm -f "$PID_FILE"
    warn "服务未在运行"
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  info "停止服务 (PID $pid) ..."
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
  done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  ok "已停止"
}

do_status() {
  if is_running && health_ok; then
    ok "运行中: $(url)  (PID $(cat "$PID_FILE"))"
    curl -s "$(url)/api/health"; echo
  elif is_running; then
    warn "进程存在但 /api/health 无响应 (PID $(cat "$PID_FILE"))"
  else
    warn "未运行"
  fi
}

do_logs() {
  [[ -f "$LOG_FILE" ]] || fail "还没有日志文件，先启动服务"
  tail -n 50 -f "$LOG_FILE"
}

case "$COMMAND" in
  start)   do_start_bg ;;
  run)     do_run_fg ;;
  stop)    do_stop ;;
  restart) do_stop; do_start_bg ;;
  status)  do_status ;;
  logs)    do_logs ;;
esac
