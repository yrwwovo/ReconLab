#!/usr/bin/env bash
# 起「对话式作战台」的编排服务（默认 127.0.0.1:8091）
#
#   bash console/start-console.sh
#
# 前置：
#   1) 后端起着（bash scripts/setup-local.sh → 8090）
#   2) console/.env 里两把 key 填好了（没有就从 .env.example 复制一份）
# 前端（npm run dev → 5173）会把 /console 反代到这里。
set -euo pipefail

cd "$(dirname "$0")/.."
PY="${PYTHON:-python3}"

if [ ! -f console/.env ]; then
  echo "没找到 console/.env —— 先复制一份再填 key："
  echo "    cp console/.env.example console/.env"
  echo "（没填也能起，页面会提示缺哪项；填上重启即可）"
fi

echo "== 对话式作战台 · 编排服务 =="
exec "$PY" console/server.py
