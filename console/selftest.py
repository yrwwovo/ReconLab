#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
编排层 · 离线端到端自测（不需要真模型 key，也不需要联网）

拿【真后端】+【假模型】把四条分支全跑一遍，验证的不是"代码看起来对"，
而是"这条路径真的走得通"：

  1. happy       主路径：queue → claim → GET 预检 → 证据 → 回写 confirmed
  2. conflict412 有人抢先改了内容 → 412 → 换新 etag 重试一次 → 成功
  3. superseded  领到一条已作废的 → 409 ALREADY_SUPERSEDED → 换目标（不是"重开"）
  4. leased      租约在别人手上 → 409 ALREADY_CLAIMED → 弃单，不许本地重试

前置：后端已起、表结构已导（scripts/setup-local.sh 那套）。

    python3 console/selftest.py --reconlab http://127.0.0.1:8090
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from agent.config import Config            # noqa: E402
from agent.loop import Orchestrator        # noqa: E402
from agent.store import Store              # noqa: E402

PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("  ✅ " if cond else "  ❌ ") + name + ("" if cond else "   %s" % detail))


def api(base, method, path, body=None, key="", extra=None):
    hdrs = {"Accept": "application/json"}
    if key:
        hdrs["Authorization"] = "Bearer " + key
    if extra:
        hdrs.update(extra)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(base + path, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8", "replace") or "{}")
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read().decode("utf-8", "replace") or "{}")
        except ValueError:
            return exc.code, {}


def free_port(start=8095):
    import socket
    for p in range(start, start + 40):
        s = socket.socket()
        try:
            s.bind(("127.0.0.1", p))
            s.close()
            return p
        except OSError:
            s.close()
    raise RuntimeError("没找到空端口")


def make_fixtures(base, email, password, out_path):
    cmd = [sys.executable, os.path.join(ROOT, "scripts", "fixtures.py"),
           "--url", base, "--email", email, "--password", password, "--out", out_path]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        print(res.stdout[-2000:])
        print(res.stderr[-2000:])
        raise SystemExit("造夹具失败")
    with open(out_path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def run_scenario(orch, store, sid, text):
    store.create_session("自测：" + text[:40]) if False else None
    orch.run_turn(sid, text)
    events = store.events_after(sid, 0, 2000)
    return events


def tools_used(events):
    out = []
    for ev in events:
        if ev["kind"] == "tool_call":
            out.append(ev["payload"].get("tool"))
    return out


def actions(events):
    out = []
    for ev in events:
        if ev["kind"] == "tool_result":
            act = ((ev["payload"].get("outcome") or {}).get("result") or {}).get("action") or {}
            if act.get("action"):
                out.append(act["action"])
    return out


def final_states(events):
    """收尾时状态机账本的快照（done 事件里带的那份，最准）。"""
    for ev in reversed(events):
        if ev["kind"] == "done":
            return ev["payload"].get("killchain") or {}
    return {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reconlab", default="http://127.0.0.1:8090")
    ap.add_argument("--email", default="admin@reconlab.local")
    ap.add_argument("--password", default="reconlab123")
    args = ap.parse_args()
    base = args.reconlab.rstrip("/")

    print("== 编排层自测 ==")
    tmp = tempfile.mkdtemp(prefix="console-selftest-")
    fixtures = make_fixtures(base, args.email, args.password, os.path.join(tmp, "fixtures.json"))
    agent_key = fixtures["agent_key"]
    host = fixtures["host"]
    print("夹具好了：host=%s agent=%s" % (host, fixtures["agent_id"]))

    mock = subprocess.Popen([sys.executable, os.path.join(HERE, "mock_llm.py"),
                             "--port", "0", "--reconlab", base, "--agent-key", agent_key,
                             "--admin-email", args.email, "--admin-password", args.password],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    port = 0
    deadline = time.time() + 10
    while time.time() < deadline:
        line = mock.stdout.readline()
        if not line:
            break
        if line.startswith("MOCK_LLM_PORT="):
            port = int(line.strip().split("=", 1)[1])
            break
    if not port:
        raise SystemExit("假模型没起来")
    print("假模型端口 %d" % port)

    env = {
        "CONSOLE_LLM_BASE_URL": "http://127.0.0.1:%d/v1" % port,
        "CONSOLE_LLM_API_KEY": "sk-mock-selftest",
        "CONSOLE_LLM_MODEL": "mock-reactive",
        "CONSOLE_LLM_RETRIES": "1",
        "CONSOLE_LLM_TIMEOUT": "30",
        "RECONLAB_BASE_URL": base,
        "RECONLAB_WORKER_KEY": agent_key,
        "RECONLAB_WORKER_ID": "console-selftest",
        "CONSOLE_DB": os.path.join(tmp, "console.sqlite"),
    }
    env.update(os.environ)
    cfg = Config(env)
    store = Store(cfg.db_path)
    orch = Orchestrator(cfg, store)

    try:
        # ── 0. 健康检查 ──
        print("\n【0】配置与连通")
        health = cfg.health()
        check("模型 key 已识别（自测用假 key）", health["llm"]["key_configured"])
        check("后端 key 已识别", health["reconlab"]["key_configured"])
        st, meta = api(base, "GET", "/api/contract/meta", key=agent_key)
        check("后端契约自描述可取", st == 200 and meta.get("contract_version") == 2, str(meta)[:200])
        check("工具表里 http_probe 默认不暴露（主动探测关闭）",
              "http_probe" not in [t["function"]["name"] for t in orch.tools()])
        check("回写工具被 strict 化（additionalProperties=false）",
              all(t["function"]["parameters"].get("additionalProperties") is False
                  for t in orch.tools() if t["function"]["name"] == "item_write_verdict"))

        # ── 1. happy ──
        # 注意：夹具里的 A 是被 fixtures.py 自己领着的（留给手测），所以这里另造一条干净的
        print("\n【1】主路径 happy")
        st, fresh = api(base, "POST", "/api/verification/queue", {
            "kind": "open_redirect", "target": host,
            "endpoint": "https://%s/selftest/happy-%d?next=https://evil.example/" % (host, int(time.time())),
            "severity": "medium", "confidence": 50, "title": "主路径夹具",
            "raw_request": "GET /selftest/happy?next=https://evil.example/ HTTP/1.1",
            "raw_response": "HTTP/1.1 302 Found\nLocation: https://evil.example/",
        }, key=agent_key, extra={"Idempotency-Key": "selftest-happy-" + str(time.time())})
        a_id = (fresh.get("item") or {}).get("id")
        check("主路径夹具已就位", bool(a_id), json.dumps(fresh)[:200])
        sid = store.create_session("happy")
        events = run_scenario(orch, store, sid, "场景=happy item=%s 把这条干净的 suspected 判掉。" % a_id)
        used = tools_used(events)
        st, item = api(base, "GET", "/api/verification/queue/" + a_id, key=agent_key)
        check("按顺序走了 claim → 预检 → 回写",
              used[:2] == ["queue_overview", "item_claim"] and "item_write_verdict" in used,
              str(used))
        check("回写落到 confirmed", (item.get("item") or {}).get("state") == "confirmed",
              json.dumps(item)[:200])
        check("判定依据与复现步骤写进去了",
              "302" in ((item.get("item") or {}).get("verdict_note") or "")
              and len((item.get("item") or {}).get("reproduction_steps") or []) >= 2)
        check("证据挂上去了（≥1 条）",
              len((item.get("item") or {}).get("evidence") or []) >= 1,
              json.dumps((item.get("item") or {}).get("evidence"))[:200])
        check("没有触发任何错误处置动作", actions(events) == [], str(actions(events)))

        # ── 2. conflict412 ──
        print("\n【2】412：内容被别人抢先改了")
        st, new_item = api(base, "POST", "/api/verification/queue", {
            "kind": "open_redirect", "target": host,
            "endpoint": "https://%s/t412/x?next=https://evil.example/" % host,
            "severity": "medium", "confidence": 55, "title": "412 夹具",
            "raw_request": "GET /t412/x?next=https://evil.example/ HTTP/1.1",
            "raw_response": "HTTP/1.1 302 Found\nLocation: https://evil.example/",
        }, key=agent_key, extra={"Idempotency-Key": "selftest-412-" + str(time.time())})
        b_id = (new_item.get("item") or {}).get("id")
        sid = store.create_session("conflict412")
        events = run_scenario(orch, store, sid, "场景=conflict412 item=%s 回写这条。" % b_id)
        acts = actions(events)
        st, item = api(base, "GET", "/api/verification/queue/" + b_id, key=agent_key)
        check("认出 412 并换新 etag 重试", "retry_new_etag" in acts, str(acts))
        check("重试后写成功（state=confirmed）", (item.get("item") or {}).get("state") == "confirmed",
              json.dumps(item)[:220])
        check("412 处置里没夹带租约逻辑（动作只有 retry_new_etag）",
              [a for a in acts if a not in ("retry_new_etag",)] == [], str(acts))

        # ── 3. superseded ──
        print("\n【3】已作废记录：换目标而不是「重开」")
        b_old = fixtures["fixtures"]["B_superseded"]["id"]
        sid = store.create_session("superseded")
        events = run_scenario(orch, store, sid,
                              "场景=superseded item=%s 处理这条（它可能已经被取代了）。" % b_old)
        acts = actions(events)
        states = final_states(events)
        check("识别出 ALREADY_SUPERSEDED 并 follow_supersede",
              "follow_supersede" in acts, str(acts))
        check("旧记录被标成弃单", (states.get(b_old) or {}).get("stage") == "ABANDONED",
              json.dumps(states.get(b_old)))
        check("换目标后确实动了新那条（有 claim 记录）", "item_claim" in tools_used(events))
        new_id = fixtures["fixtures"]["B_superseded"]["superseded_by"]
        check("新那条被领走（状态机里有它）", new_id in states, json.dumps(list(states.keys())))
        check("旧记录的状态机轨迹里有「被取代」这一笔",
              any("取代" in (h.get("note") or "") or "顶替" in (h.get("note") or "")
                  for h in ((states.get(b_old) or {}).get("history") or [])),
              json.dumps((states.get(b_old) or {}).get("history")))

        # ── 4. leased ──
        print("\n【4】租约在别人手上：弃单，不许本地重试")
        c_id = fixtures["fixtures"]["C_leased"]["id"]
        sid = store.create_session("leased")
        events = run_scenario(orch, store, sid, "场景=leased item=%s 试着领这条。" % c_id)
        acts = actions(events)
        states = final_states(events)
        used = tools_used(events)
        check("撞上 ALREADY_CLAIMED 后弃单", "abandon" in acts, str(acts))
        check("没有对同一条反复 claim（claim 只出现一次）",
              used.count("item_claim") == 1, str(used))
        check("弃单后台账是 ABANDONED", (states.get(c_id) or {}).get("stage") == "ABANDONED",
              json.dumps(states.get(c_id))[:300])

        print("\n============================================================")
        print("通过 %d 项 / 失败 %d 项" % (len(PASS), len(FAIL)))
        if FAIL:
            print("失败项：")
            for f in FAIL:
                print("  - " + f)
        return 1 if FAIL else 0
    finally:
        try:
            mock.terminate()
            mock.wait(timeout=5)
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
