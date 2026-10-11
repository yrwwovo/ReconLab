# -*- coding: utf-8 -*-
"""
假模型（剧本 + 反应式）—— 自测专用，不是给生产用的

它实现 /v1/chat/completions，按「已经拿到的工具结果」决定下一步调什么工具，
所以能把真实链路上的分支全跑一遍：

  happy / conflict412 / superseded / leased

其中 conflict412 那一档还会**真的去改一次后端内容**（模拟"另一个 worker 抢先改了"），
用来验证 412 → 换新 etag 重试这条路径真的走得通，而不是纸上写着好看。

    python3 console/mock_llm.py --port 8092 --reconlab http://127.0.0.1:8090 --agent-key rlk_xxx
"""

import argparse
import json
import sys
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class State(object):
    backend = ""
    agent_key = ""
    admin_token = ""
    calls = []          # 记录收到几次请求，给自测断言用


def _api(method, path, body=None, key=""):
    hdrs = {"Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    if key:
        hdrs["Authorization"] = "Bearer " + key
    req = urllib.request.Request(State.backend + path, data=data, method=method, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8", "replace") or "{}")
    except Exception as exc:
        return {"_error": str(exc)}


def _tool_calls(resp, name, args):
    return {
        "id": "chatcmpl-" + uuid.uuid4().hex[:8],
        "object": "chat.completion",
        "model": "mock-reactive",
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": resp if resp else None,
                "reasoning_content": "（假模型：按剧本走）",
                "tool_calls": [{"id": "call_" + uuid.uuid4().hex[:8], "type": "function",
                                "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}],
            },
            "finish_reason": "tool_calls",
        }],
        "usage": {"prompt_tokens": 1200, "completion_tokens": 42, "total_tokens": 1242},
    }


def _text(msg):
    return {
        "id": "chatcmpl-" + uuid.uuid4().hex[:8],
        "object": "chat.completion",
        "model": "mock-reactive",
        "choices": [{"index": 0,
                     "message": {"role": "assistant", "content": msg},
                     "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 1200, "completion_tokens": 60, "total_tokens": 1260},
    }


def _plan():
    plan = {
        "intent": "把队列里指定的那条记录判掉并回写",
        "hypothesis": "夹具里已有 supposed 记录，按契约走 claim → GET 预检 → PATCH",
        "steps": [
            {"id": "s1", "goal": "看队列确认目标", "tool": "queue_overview", "done_when": "拿到目标 id"},
            {"id": "s2", "goal": "领租约", "tool": "item_claim", "done_when": "拿到 lease_token"},
            {"id": "s3", "goal": "预检拿 etag", "tool": "item_read", "done_when": "etag 到手"},
            {"id": "s4", "goal": "对判据、传证据", "tool": "rubric_lookup", "done_when": "证据 id 到手"},
            {"id": "s5", "goal": "回写判定", "tool": "item_write_verdict", "done_when": "200 落库"},
        ],
        "stop_when": "回写完成或被状态机拦下",
    }
    return _text(json.dumps(plan, ensure_ascii=False))


def _parse_messages(messages):
    user_text = ""
    results = []
    called = []
    for m in messages:
        role = m.get("role")
        if role == "user" and not user_text:
            user_text = m.get("content") or ""
        if role == "assistant":
            for tc in (m.get("tool_calls") or []):
                fn = tc.get("function") or {}
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except ValueError:
                    args = {}
                called.append({"name": fn.get("name"), "args": args, "id": tc.get("id")})
        if role == "tool":
            raw = m.get("content") or "{}"
            try:
                results.append({"call_id": m.get("tool_call_id"), "out": json.loads(raw)})
            except ValueError:
                results.append({"call_id": m.get("tool_call_id"), "out": {}})
    return user_text, called, results


def _fields(user_text):
    fields = {}
    for token in (user_text or "").replace("\n", " ").split():
        if "=" in token:
            k, v = token.split("=", 1)
            fields[k.strip()] = v.strip().strip(",。")
    return fields


def host_placeholder(fields):
    """没读到 endpoint 时的兜底（正常流程用不到，读到了就用真值）。"""
    return fields.get("host") or "unknown.local"


def _action_of(out):
    """从一次工具 outcome 里取处置动作（字符串）。"""
    a = out.get("action")
    if isinstance(a, str) and a:
        return a
    inner = ((out.get("result") or {}).get("action") or {})
    return inner.get("action") or ""


def _error_of(out):
    return (out.get("result") or {}).get("error") or out.get("error") or {}


def _error_data(out):
    d = _error_of(out).get("data")
    return d if isinstance(d, dict) else {}


def _last_action(results):
    for r in reversed(results):
        out = r.get("out") or {}
        a = _action_of(out)
        if a:
            return a, out, r
    return "", {}, {}


def decide(messages):
    user_text, called, results = _parse_messages(messages)
    f = _fields(user_text)
    item_id = f.get("item") or ""
    scenario = f.get("场景") or "happy"

    action, failed_out, _ = _last_action(results)

    if results:
        last = results[-1].get("out") or {}
        if last.get("blocked"):
            return _text("被编排层拦下，停手：%s" % (last.get("error") or ""))
        if last.get("ok") is False and not _action_of(last):
            return _text("工具报错，停手：%s" % json.dumps(_error_of(last), ensure_ascii=False)[:200])

    if action == "fatal":
        return _text("配置层面的硬错，停手：%s" % json.dumps(failed_out.get("error", {}), ensure_ascii=False))
    if action == "abandon":
        return _text("按状态机弃单收尾：%s" % json.dumps(
            ((failed_out.get("result") or {}).get("action") or {}).get("reason", ""), ensure_ascii=False))
    if action == "follow_supersede":
        new_id = str(_error_data(failed_out).get("superseded_by") or "")
        return _tool_calls("这条作废了，按 superseded_by 换目标", "item_read",
                           {"item_id": new_id or item_id})
    if action == "retry_new_etag":
        # 照原样重试一次回写（If-Match 由编排层注入，这里不用改参数）
        last_write = None
        for c in reversed(called):
            if c["name"] == "item_write_verdict":
                last_write = c["args"]
                break
        if last_write and scenario != "conflict412_forever":
            return _tool_calls("内容被人改过，拿新 etag 重试提交", "item_write_verdict", last_write)
        return _text("反复 412，弃单收尾")

    # ── 正常推进 ──
    ok_results = [r for r in results if (r.get("out") or {}).get("ok")]
    names = []
    for c in called:
        if c["name"] not in names:
            names.append(c["name"])

    if "queue_overview" not in names:
        return _tool_calls("先看队列", "queue_overview", {"state": "suspected", "limit": 20})

    if "item_claim" not in names:
        return _tool_calls("挑中目标，领租约", "item_claim", {"item_id": item_id})

    if "item_read" not in names:
        return _tool_calls("预检拿最新 etag", "item_read", {"item_id": item_id})

    read_out = {}
    for r in results:
        out = r.get("out") or {}
        it = (out.get("result") or {}).get("item")
        if it and it.get("id"):
            if not item_id or it.get("id") == item_id:
                read_out = out
                break
    view = ((read_out.get("result") or {}).get("item")) or {}
    rule = view.get("rule_id") or view.get("kind") or "open_redirect"
    endpoint = view.get("endpoint") or ("https://%s/" % host_placeholder(f))
    raw_req = view.get("raw_request") or "GET / HTTP/1.1"
    raw_resp = view.get("raw_response") or "HTTP/1.1 302 Found"

    if "scope_check" not in names:
        return _tool_calls("碰目标之前先过范围（硬边界）", "scope_check", {"urls": [endpoint]})

    if "rubric_lookup" not in names:
        return _tool_calls("判之前先看判据", "rubric_lookup", {"kind": rule})

    if "evidence_submit" not in names:
        return _tool_calls("先把证据传上去", "evidence_submit",
                           {"content_text": "%s\n\n%s" % (raw_req, raw_resp),
                            "kind": "http_exchange", "note": "夹具探针的请求/响应原文"})

    ev_id = ""
    for r in results:
        out = r.get("out") or {}
        res = out.get("result") or {}
        if res.get("evidence_id"):
            ev_id = res["evidence_id"]
    if not ev_id:
        return _text("证据没传上去，停手交给人看")

    if "item_write_verdict" not in names:
        if scenario == "conflict412":
            _bump_from_outside(item_id)
        return _tool_calls("证据齐了，回写判定", "item_write_verdict", {
            "state": "confirmed",
            "verdict_note": "试验组 302 且 Location 指向站外，对照组仅站内跳转，二轮复核一致。",
            "reason_code": "confirmed_external_redirect",
            "confidence": 88,
            "reproduction_steps": [
                "1) curl -i '目标/api/jump?next=https://evil.example/' → 302 Location: https://evil.example/",
                "2) 对照组 next=/home → 302 Location: /home（站内）",
                "3) 重放两次结果一致",
            ],
            "checks": [{"id": "reproduce", "state": "pass", "note": "两次一致"},
                       {"id": "control", "state": "pass", "note": "对照组只跳站内"}],
            "evidence_ids": [ev_id],
            "curl": "curl -i '目标/api/jump?next=https://evil.example/'",
        })

    if "finish" not in names:
        return _tool_calls("", "finish", {"summary": "目标记录已判定并回写，证据已归档。",
                                          "next": "可以再挑下一条 suspected"})

    return _text("收工")


def _bump_from_outside(item_id):
    """模拟"内容被别人从后台改了"（比如人工在管理界面动了这条）→ 后续 PATCH 必然撞 412。

    关键：走管理后台改，**不动租约** —— 这样测的才是纯粹的 412 重试，
    而不是"外部写入顺手把你的租约也清了"（那是另一条路径，会被 409 接走）。
    """
    if not State.admin_token:
        sys.stderr.write("[mock] 没给管理凭据，跳过外部改动\n")
        return
    try:
        body = json.dumps({"verdict_note": "后台人工补了一句备注（外部改动，不动租约）"}).encode()
        req = urllib.request.Request(
            State.backend + "/api/collections/review_queue/records/" + item_id,
            data=body, method="PATCH",
            headers={"Content-Type": "application/json", "Authorization": State.admin_token})
        urllib.request.urlopen(req, timeout=20).read()
    except Exception as exc:
        sys.stderr.write("[mock] 外部写入没成功：%s\n" % exc)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n).decode("utf-8", "replace") if n else "{}"
        try:
            payload = json.loads(raw)
        except ValueError:
            payload = {}
        State.calls.append({"model": payload.get("model"),
                            "tools": [t["function"]["name"] for t in (payload.get("tools") or [])]})
        rf = payload.get("response_format") or {}
        if (rf.get("json_schema") or {}).get("name") == "reconlab_plan":
            out = _plan()
        else:
            out = decide(payload.get("messages") or [])
        body = json.dumps(out, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        body = json.dumps({"ok": True, "calls": len(State.calls)}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8092)
    ap.add_argument("--reconlab", default="http://127.0.0.1:8090")
    ap.add_argument("--agent-key", default="")
    ap.add_argument("--admin-email", default="")
    ap.add_argument("--admin-password", default="")
    args = ap.parse_args()
    State.backend = args.reconlab.rstrip("/")
    State.agent_key = args.agent_key
    if args.admin_email:
        try:
            auth = _api("POST", "/api/collections/_superusers/auth-with-password",
                        {"identity": args.admin_email, "password": args.admin_password})
            State.admin_token = auth.get("token") or ""
        except Exception as exc:
            sys.stderr.write("[mock] 管理员登录失败：%s\n" % exc)
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    srv.daemon_threads = True
    real_port = srv.server_address[1]
    # 这行会被 selftest 解析（--port 0 时用系统分配的空闲端口，避免撞上别的服务）
    print("MOCK_LLM_PORT=%d" % real_port, flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
