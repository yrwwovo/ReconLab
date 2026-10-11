#!/usr/bin/env bash
# ReconLab 本地后端一键初始化
#   起 PocketBase -> 建管理员 -> 导入表结构
# 用法: bash scripts/setup-local.sh
set -euo pipefail

cd "$(dirname "$0")/.."

PB_VERSION="${PB_VERSION:-0.23.4}"
PB_PORT="${PB_PORT:-8090}"
PB_ADMIN_EMAIL="${PB_ADMIN_EMAIL:-admin@reconlab.local}"
PB_ADMIN_PASS="${PB_ADMIN_PASS:-reconlab123}"
PB_ROOT="$PWD/.pb"
PB_BIN="$PB_ROOT/pocketbase"
PB_DATA="$PWD/pb_data"

echo "== ReconLab 本地后端初始化 =="
echo "版本 $PB_VERSION / 端口 $PB_PORT"

if ! command -v python3 >/dev/null 2>&1; then
  echo "缺少 python3，请先安装 Python 3.9+"
  exit 1
fi

if [ ! -x "$PB_BIN" ]; then
  OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64|amd64) ARCH="amd64" ;;
    arm64|aarch64) ARCH="arm64" ;;
  esac
  case "$OS" in
    linux) PLATFORM="linux" ;;
    darwin) PLATFORM="darwin" ;;
    *) echo "未识别的系统 $OS，请手动下载 PocketBase 放到 $PB_BIN"; exit 1 ;;
  esac
  mkdir -p "$PB_ROOT"
  URL="https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_${PLATFORM}_${ARCH}.zip"
  echo "下载 PocketBase: $URL"
  curl -fL -o "$PB_ROOT/pb.zip" "$URL"
  ( cd "$PB_ROOT" && unzip -o pb.zip pocketbase >/dev/null )
  chmod +x "$PB_BIN"
fi

mkdir -p "$PB_DATA"
echo "配置管理员账号: $PB_ADMIN_EMAIL"
"$PB_BIN" superuser upsert "$PB_ADMIN_EMAIL" "$PB_ADMIN_PASS" --dir "$PB_DATA" >/dev/null

if curl -s -o /dev/null "http://127.0.0.1:${PB_PORT}/api/health" 2>/dev/null; then
  echo "检测到后端已在运行，跳过启动"
else
  echo "启动后端(后台)…"
  nohup "$PB_BIN" serve --http="127.0.0.1:${PB_PORT}" --dir "$PB_DATA" > "$PB_ROOT/serve.log" 2>&1 &
  echo $! > "$PB_ROOT/serve.pid"
  for _ in $(seq 1 20); do
    sleep 0.5
    curl -s -o /dev/null "http://127.0.0.1:${PB_PORT}/api/health" && break
  done
fi

echo "导入表结构…"
python3 scripts/init_pb.py --url "http://127.0.0.1:${PB_PORT}" \
  --email "$PB_ADMIN_EMAIL" --password "$PB_ADMIN_PASS"

echo "升级到契约 v2（补字段 + 灌判定准则，已存在的不动）…"
python3 scripts/upgrade_contract_v2.py --url "http://127.0.0.1:${PB_PORT}" \
  --email "$PB_ADMIN_EMAIL" --password "$PB_ADMIN_PASS"

cat <<EOF

后端就绪: http://127.0.0.1:${PB_PORT}
管理后台: http://127.0.0.1:${PB_PORT}/_/  ($PB_ADMIN_EMAIL / $PB_ADMIN_PASS)

接下来:
  1) 前端:  npm install && npm run dev        -> http://127.0.0.1:5173
  2) 在网页里注册一个账号(那就是你的控制台账号)
  3) 执行器: python3 public/worker/reconlab-worker.py \\
       --server http://127.0.0.1:${PB_PORT} --email 你的邮箱 --password 你的密码

停止后端: kill \$(cat .pb/serve.pid)
EOF
