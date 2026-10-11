# -*- coding: utf-8 -*-
"""
对话式作战台 · 编排服务入口（纯标准库，不用装任何东西）

    python3 console/server.py            # 默认 127.0.0.1:8091

接口（前端 /api-console 反代到这里）：
    GET  /health                     配置与依赖状态（key 只回显"配没配"，绝不回显原文）
    GET  /sessions                   会话列表
    POST /sessions                   新建会话 {"title": "..."}
    GET  /sessions/{id}              会话详情（消息 + 状态机快照）
    POST /sessions/{id}/messages     发一条消息 {"text": "..."} → 后台起一轮，立刻返回
    POST /sessions/{id}/cancel       叫停当前这轮
    GET  /sessions/{id}/events?after=N   事件流（SSE；N 之后的新事件）
"""

import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from agent.config import Config          # noqa: E402
from agent.loop import Orchestrator      # noqa: E402
from agent.store import Store            # noqa: E402

CFG = Config()
STORE = Store(CFG.db_path)
ORCH = Orchestrator(CFG, STORE)


class Handler(BaseHTTPRequestHandler):
    server_version = "ReconLabConsole/1.0"
    protocol_version = "HTTP/1.1"

    # ── 工具 ──

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0:
            return {}
        raw = self.rfile.read(n).decode("utf-8", "replace")
        try:
            return json.loads(raw) if raw else {}
        except ValueError:
            return {"_raw": raw[:500]}

    def log_message(self, fmt, *args):
        if os.environ.get("CONSOLE_VERBOSE"):
            sys.stderr.write("[console] %s\n" % (fmt % args))

    # ── 路由 ──

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        parts = [p for p in u.path.split("/") if p]
        q = parse_qs(u.query)

        if u.path in ("/health", "/"):
            health = CFG.health()
            if health["reconlab"]["key_configured"]:
                res = ORCH.client.contract_meta()
                health["reconlab"]["reachable"] = bool(res.ok)
                health["reconlab"]["contract_version"] = (res.data or {}).get("contract_version")
                if not res.ok:
                    health["reconlab"]["error"] = res.code or res.transport_error
            health["missing"] = CFG.missing()
            return self._json(200, health)

        if u.path == "/sessions":
            return self._json(200, {"sessions": STORE.list_sessions()})

        if len(parts) == 2 and parts[0] == "sessions":
            s = STORE.get_session(parts[1])
            if not s:
                return self._json(404, {"error": "会话不存在"})
            return self._json(200, {"session": s, "messages": STORE.messages(parts[1], 300),
                                    "running": ORCH.is_running(parts[1])})

        if len(parts) == 3 and parts[0] == "sessions" and parts[2] == "events":
            after = int((q.get("after") or ["0"])[0] or 0)
            return self._sse(parts[1], after)

        return self._json(404, {"error": "没有这个接口"})

    def do_POST(self):
        u = urlparse(self.path)
        parts = [p for p in u.path.split("/") if p]
        body = self._read_body()

        if u.path == "/sessions":
            sid = STORE.create_session(str(body.get("title") or "新回合"))
            return self._json(201, {"session": STORE.get_session(sid)})

        if len(parts) == 3 and parts[0] == "sessions" and parts[2] == "messages":
            sid = parts[1]
            if not STORE.get_session(sid):
                return self._json(404, {"error": "会话不存在"})
            text = str(body.get("text") or "").strip()
            if not text:
                return self._json(400, {"error": "text 不能为空"})
            if ORCH.is_running(sid):
                return self._json(409, {"error": "这一轮还在跑，先等它结束或叫停"})
            missing = CFG.missing()
            if missing:
                return self._json(428, {"error": "还没配好，缺：%s" % "、".join(missing),
                                        "missing": missing})
            ORCH.start_turn(sid, text)
            return self._json(202, {"accepted": True, "session_id": sid})

        if len(parts) == 3 and parts[0] == "sessions" and parts[2] == "cancel":
            ORCH.cancel(parts[1])
            return self._json(200, {"canceled": True})

        return self._json(404, {"error": "没有这个接口"})

    # ── SSE ──

    def _sse(self, sid, after):
        if not STORE.get_session(sid):
            return self._json(404, {"error": "会话不存在"})
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self._cors()
        self.end_headers()

        cursor = after
        deadline = time.time() + 300          # 单连接最长 5 分钟，前端会自动重连
        try:
            while time.time() < deadline:
                events = STORE.events_after(sid, cursor, 200)
                for ev in events:
                    cursor = ev["seq"]
                    chunk = "id: %d\nevent: %s\ndata: %s\n\n" % (
                        ev["seq"], ev["kind"], json.dumps(ev, ensure_ascii=False))
                    self.wfile.write(chunk.encode("utf-8"))
                self.wfile.flush()
                if not events:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                if ORCH.is_running(sid) is False and events and events[-1]["kind"] in ("done", "error"):
                    break
                time.sleep(0.6)
        except (BrokenPipeError, ConnectionResetError):
            return
        try:
            self.wfile.write(b"event: eof\ndata: {}\n\n")
            self.wfile.flush()
        except Exception:
            pass


def main():
    missing = CFG.missing()
    print("== ReconLab 对话式作战台 · 编排服务 ==")
    print("监听: http://%s:%d" % (CFG.host, CFG.port))
    print("后端: %s（%s）" % (CFG.reconlab_base_url,
                              "key 已配" if CFG.reconlab_configured else "缺 RECONLAB_WORKER_KEY"))
    print("模型: %s @ %s（%s）" % (CFG.llm_model, CFG.llm_base_url,
                                  "key 已配" if CFG.llm_configured else "缺 CONSOLE_LLM_API_KEY"))
    if missing:
        print("⚠ 还没配好：%s —— 服务照常起，配上就能跑。" % "、".join(missing))

    # 端口被占就顺延几位：本地常常同时开着别的东西，别为一个端口卡住
    srv = None
    last = None
    for offset in range(0, 10):
        port = CFG.port + offset
        try:
            srv = ThreadingHTTPServer((CFG.host, port), Handler)
            if offset:
                print("端口 %d 被占用，改用 %d" % (CFG.port, port))
            print("前端反代目标（Vite 默认）: http://%s:%d" % (CFG.host, port))
            break
        except OSError as exc:
            last = exc
            srv = None
    if srv is None:
        print("起不来：端口 %d~%d 都被占用（%s）" % (CFG.port, CFG.port + 9, last))
        return 1

    srv.daemon_threads = True
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n收工")
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
