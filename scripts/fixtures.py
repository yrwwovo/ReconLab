#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ReconLab 契约 v2 · 联调夹具 + 契约实测探针（纯标准库）

两件事：

一、造三条假数据 —— 联调不许拿真发现去跑，每条数据专测一条分支：
    A. 干净的 suspected            → 主路径  claim → GET 预检 → PATCH 200
    B. 已经被取代的（superseded_by 非空）→ 「作废就别写」那道闸
    C. 租约被别的 worker 占着      → 409 那条路（ALREADY_CLAIMED）

二、探针 —— 回答一条悬着的契约问题（两边都在猜的那条）：
    记录被 supersede 之后，
      1. 老记录的 etag 会不会重算？
      2. 拿老 etag / 新 etag 去 PATCH 一条已取代的记录，服务端返 409 还是 412？

用法：
    python3 scripts/fixtures.py --url http://127.0.0.1:8090            # 造夹具（顺带跑探针）
    python3 scripts/fixtures.py --url http://127.0.0.1:8090 --probe    # 只跑探针
    python3 scripts/fixtures.py --url http://127.0.0.1:8090 --out fixtures.json

跑完把 fixtures.json 留着，里面的 id / etag / lease_token 可以直接拿去手测。
夹具带 `--tag` 前缀，清理：
    python3 scripts/fixtures.py --url ... --clean fixtures.json
"""

import argparse
import hashlib
import json
import time
import urllib.error
import urllib.request
import uuid


# ───────────────────────── HTTP（和 contract_e2e_test.py 同一套） ─────────────────────────

def http(method, url, body=None, headers=None, token=None, timeout=30):
    hdrs = {"Accept": "application/json"}
    if headers:
        hdrs.update(headers)
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs["Content-Type"] = "application/json"
    if token:
        hdrs["Authorization"] = token
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = resp.read().decode("utf-8", "replace")
            status = resp.status
            resp_headers = {k.lower(): v for k, v in resp.getheaders()}
    except urllib.error.HTTPError as exc:
        payload = exc.read().decode("utf-8", "replace")
        status = exc.code
        resp_headers = {k.lower(): v for k, v in exc.getheaders()}
    try:
        parsed = json.loads(payload) if payload else {}
    except ValueError:
        parsed = {"_raw": payload[:500]}
    return status, parsed, resp_headers


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def now_iso(offset=0):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + offset))


def short(body):
    """把响应压成一行，方便肉眼对——错误码优先，不是错误就给摘要。"""
    if isinstance(body, dict):
        if body.get("code"):
            extra = ""
            data = body.get("data") or {}
            if isinstance(data, dict):
                if data.get("current_etag"):
                    extra = " current_etag=%s" % data["current_etag"]
                elif data.get("superseded_by"):
                    extra = " superseded_by=%s" % data["superseded_by"]
                elif data.get("lease"):
                    extra = " lease=%s" % json.dumps(data["lease"], ensure_ascii=False)
            return "%s%s" % (body["code"], extra)
        if body.get("item"):
            it = body["item"]
            return "item=%s state=%s rev=%s etag=%s" % (
                it.get("id"), it.get("state"), it.get("rev"), it.get("etag"))
    return json.dumps(body, ensure_ascii=False)[:160]


# ───────────────────────── 环境准备 ─────────────────────────

def admin_login(base, email, password):
    st, body, _ = http("POST", base + "/api/collections/_superusers/auth-with-password",
                       {"identity": email, "password": password})
    if st != 200:
        raise SystemExit("管理员登录失败: %s %s" % (st, short(body)))
    return body["token"]


def ensure_agent(base, admin, tag):
    """建一个夹具 Agent（ingest + review），返回 (id, key)。"""
    key = "rlk_" + uuid.uuid4().hex + uuid.uuid4().hex[:8]
    st, body, _ = http("POST", base + "/api/collections/agents/records", {
        "name": "fixture-agent-%s" % tag,
        "identity": "fixture-%s@reconlab.local" % tag,
        "scopes": "ingest,review",
        "status": "online",
        "api_key_hash": sha256_hex(key.encode()),
        "key_prefix": key[:16],
        "note": "scripts/fixtures.py 造的联调身份",
    }, token=admin)
    if st not in (200, 201):
        raise SystemExit("建夹具 Agent 失败: %s %s" % (st, short(body)))
    return body["id"], key


def ensure_scope(base, admin, tag, host):
    st, body, _ = http("POST", base + "/api/collections/scopes/records", {
        "name": "fixture-scope-%s" % tag,
        "assets": [
            {"type": "domain", "value": host},
            {"type": "url_prefix", "value": "https://%s/v1/" % host},
        ],
        "status": "active",
        "authorized_at": now_iso(-60),
        "expires_at": now_iso(86400),
        "authorization_reference": "FIXTURE-%s" % tag,
        "note": "联调夹具范围，可随时删",
    }, token=admin)
    if st not in (200, 201):
        raise SystemExit("建夹具范围失败: %s %s" % (st, short(body)))
    return body["id"]


def post_item(base, auth, kind, host, path, **extra):
    payload = {
        "kind": kind,
        "target": host,
        "endpoint": "https://%s%s" % (host, path),
        "severity": "medium",
        "confidence": 40,
        "title": "%s @ %s" % (kind, path),
        "raw_request": "GET %s HTTP/1.1\nHost: %s\n" % (path, host),
        "raw_response": "HTTP/1.1 302 Found\nLocation: https://evil.example/\n",
        "curl": "curl -i 'https://%s%s'" % (host, path),
    }
    payload.update(extra)
    st, body, _ = http("POST", base + "/api/verification/queue", payload,
                       headers=dict(auth, **{"Idempotency-Key": str(uuid.uuid4())}))
    if st not in (200, 201):
        raise SystemExit("造数据失败 (%s %s): %s %s" % (kind, path, st, short(body)))
    return body["item"]


def get_item(base, auth, item_id):
    st, body, hdrs = http("GET", base + "/api/verification/queue/" + item_id, headers=auth)
    return st, body, hdrs


# ───────────────────────── 探针：supersede 之后 etag 怎么走 ─────────────────────────

def probe_supersede(base, auth, host, out):
    """
    实测三件事，结论直接钉进 out["probe"]：
      1. 老的被 supersede 之后，rev / etag 有没有重算
      2. 拿【老 etag】PATCH 一条已取代的记录 → 什么错
      3. 拿【新 etag】PATCH 同一条        → 什么错
    """
    print("\n【探针】supersede 之后，老记录的 etag 往哪走")
    old = post_item(base, auth, "open_redirect", host, "/probe/old")
    _, body0, _ = get_item(base, auth, old["id"])
    etag0 = body0["item"]["etag"]
    rev0 = body0["item"]["rev"]
    print("  老记录 %s  初始 rev=%s etag=%s" % (old["id"], rev0, etag0))

    new = post_item(base, auth, "open_redirect", host, "/probe/new",
                    supersedes=old["id"], reopened_reason="夹具：模拟重开")
    _, body1, _ = get_item(base, auth, old["id"])
    etag1 = body1["item"]["etag"]
    rev1 = body1["item"]["rev"]
    frozen = body1["item"].get("superseded_by")
    print("  被 %s 取代后  rev=%s etag=%s  superseded_by=%s" % (new["id"], rev1, etag1, frozen))

    etag_moved = etag1 != etag0
    print("  → 老记录 etag %s" % ("**重算了**（内容字段变了）" if etag_moved else "没变"))

    patch_body_ok = {"state": "rejected", "verdict_note": "夹具探针：不该写进去",
                     "reason_code": "encoded_output"}

    st_a, resp_a, _ = http("PATCH", base + "/api/verification/queue/" + old["id"], patch_body_ok,
                           headers=dict(auth, **{"If-Match": etag0}))
    print("  PATCH 用【老 etag %s】 → %s %s" % (etag0, st_a, short(resp_a)))

    st_b, resp_b, _ = http("PATCH", base + "/api/verification/queue/" + old["id"], patch_body_ok,
                           headers=dict(auth, **{"If-Match": etag1}))
    print("  PATCH 用【当前 etag %s】→ %s %s" % (etag1, st_b, short(resp_b)))

    # 对照：一条活记录（没被取代），etag 对但没租约 → 该是 409 NO_LEASE
    _, body2, _ = get_item(base, auth, new["id"])
    st_c, resp_c, _ = http("PATCH", base + "/api/verification/queue/" + new["id"], patch_body_ok,
                           headers=dict(auth, **{"If-Match": body2["item"]["etag"]}))
    print("  对照：活记录 etag 对但无租约 → %s %s" % (st_c, short(resp_c)))

    conclusion = {
        "老记录 etag 是否重算": etag_moved,
        "老 rev": rev0, "新 rev": rev1,
        "老 etag": etag0, "取代后 etag": etag1,
        "PATCH 已取代记录·老 etag": {"status": st_a, "code": resp_a.get("code")},
        "PATCH 已取代记录·当前 etag": {"status": st_b, "code": resp_b.get("code")},
        "PATCH 活记录·etag 对但无租约": {"status": st_c, "code": resp_c.get("code")},
        "结论": (
            "服务端把「已取代」检查放在 If-Match 之前，所以 PATCH 一条 superseded 记录"
            "无论 etag 新旧都是 409 ALREADY_SUPERSEDED，不会先吃 412 —— "
            "适配器里那个「409 ALREADY_SUPERSEDED → 换目标」的分支是活路径，"
            "412 分支只可能出现在活记录被别人改过内容时。"
        ) if (st_a == 409 and st_b == 409) else
        "和预期不一样，见上面原始响应 —— 以实测为准。",
    }
    out["probe"] = conclusion
    print("  结论: %s" % conclusion["结论"])
    return old, new


# ───────────────────────── 造三条夹具 ─────────────────────────

def make_fixtures(base, auth, host, tag, out):
    print("\n【夹具】造三条假数据")

    A = post_item(base, auth, "open_redirect", host, "/f/%s/a?next=x" % tag)
    print("  A 干净 suspected      id=%s etag=%s" % (A["id"], A["etag"]))

    old, B = probe_supersede(base, auth, host, out)
    _, body_b, _ = get_item(base, auth, old["id"])
    B_item = body_b["item"]
    print("  B 已取代              id=%s superseded_by=%s" % (B_item["id"], B_item.get("superseded_by")))

    C = post_item(base, auth, "sql_injection", host, "/f/%s/c?id=1" % tag,
                  parameter="id", location="query")
    st, claim_body, _ = http("POST", base + "/api/verification/queue/%s/claim" % C["id"],
                             {"worker_id": "occupier-other-worker", "lease_seconds": 900},
                             headers=auth)
    if st != 200:
        raise SystemExit("夹具 C claim 失败: %s %s" % (st, short(claim_body)))
    print("  C 租约被占            id=%s holder=occupier-other-worker" % C["id"])

    # A 走一遍主路径：claim → GET 预检 → PATCH suspected（不落终态，留给联调用）
    st, claim_a, _ = http("POST", base + "/api/verification/queue/%s/claim" % A["id"],
                          {"worker_id": "fixture-main", "lease_seconds": 900}, headers=auth)
    if st != 200:
        raise SystemExit("夹具 A claim 失败: %s %s" % (st, short(claim_a)))
    A_token = claim_a["lease_token"]
    st, body_a, _ = get_item(base, auth, A["id"])
    A_etag = body_a["item"]["etag"]
    print("  A 预检 GET            etag=%s（可与 claim 响应的 etag 对比，同源）" % A_etag)

    out["fixtures"] = {
        "A_clean": {
            "id": A["id"], "etag": A_etag, "lease_token": A_token,
            "预期": "主路径：持租约 + If-Match 正确 → PATCH 200",
            "etag_from_claim": A.get("etag"),
        },
        "B_superseded": {
            "id": B_item["id"], "etag": B_item["etag"],
            "superseded_by": B_item.get("superseded_by"),
            "预期": "往这条写 → 409 ALREADY_SUPERSEDED（证据链去 superseded_by 指向的那条）",
        },
        "C_leased": {
            "id": C["id"],
            "holder": "occupier-other-worker",
            "预期": "claim 这条 → 409 ALREADY_CLAIMED；租约到期后惰性回收才领得走",
        },
    }
    return out["fixtures"]


# ───────────────────────── 清理 ─────────────────────────

def clean(base, admin, path):
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    ids = []
    for key in ("A_clean", "B_superseded", "C_leased"):
        item = (data.get("fixtures") or {}).get(key) or {}
        if item.get("id"):
            ids.append(item["id"])
        if item.get("superseded_by"):
            ids.append(item["superseded_by"])
    for item_id in set(ids):
        st, body, _ = http("DELETE", base + "/api/collections/review_queue/records/" + item_id, token=admin)
        print("  删记录 %s → %s" % (item_id, st))
    for key, col in (("agent_id", "agents"), ("scope_id", "scopes")):
        rid = data.get(key)
        if rid:
            st, _, _ = http("DELETE", base + "/api/collections/%s/records/%s" % (col, rid), token=admin)
            print("  删 %s %s → %s" % (col, rid, st))


# ───────────────────────── main ─────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8090")
    ap.add_argument("--email", default="admin@reconlab.local")
    ap.add_argument("--password", default="reconlab123")
    ap.add_argument("--out", default="fixtures.json")
    ap.add_argument("--probe", action="store_true", help="只跑探针，不造完整夹具")
    ap.add_argument("--clean", metavar="FIXTURES_JSON", help="按 fixtures.json 清理夹具")
    args = ap.parse_args()
    base = args.url.rstrip("/")

    admin = admin_login(base, args.email, args.password)

    if args.clean:
        print("== 清理夹具 ==")
        clean(base, admin, args.clean)
        return 0

    tag = uuid.uuid4().hex[:6]
    host = "fixture-%s.lab.local" % tag
    agent_id, agent_key = ensure_agent(base, admin, tag)
    scope_id = ensure_scope(base, admin, tag, host)
    auth = {"Authorization": "Bearer " + agent_key}

    out = {
        "base_url": base,
        "host": host,
        "agent_id": agent_id,
        "agent_key": agent_key,
        "scope_id": scope_id,
        "created_at": now_iso(),
    }

    if args.probe:
        probe_supersede(base, auth, host, out)
    else:
        make_fixtures(base, auth, host, tag, out)

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)

    print("\n== 摘要 ==")
    print(json.dumps({k: v for k, v in out.items() if k != "agent_key"}, ensure_ascii=False, indent=2))
    print("\n夹具写入 %s（agent_key 也在里面，别提交进 git）" % args.out)
    print("清理: python3 scripts/fixtures.py --url %s --clean %s" % (base, args.out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
