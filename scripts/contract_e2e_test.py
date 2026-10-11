#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ReconLab 契约 v2 · 端到端实测

把契约里所有硬约束跑一遍（越界、幂等、租约、乐观锁、判定准则、证据摘要、
scope 中途失效、重定向逐跳、终态重开…）。纯标准库，不需要装东西。

用法:
    python3 scripts/contract_e2e_test.py --url http://127.0.0.1:8090 \
        --email admin@reconlab.local --password reconlab123

脚本会自己建一个临时 Agent（带 API Key）和一条临时授权范围，跑完清理。
"""

import argparse
import base64
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

PASS, FAIL = [], []


def http(method, url, body=None, headers=None, raw_body=None, content_type=None, token=None):
    hdrs = {"Accept": "application/json"}
    if headers:
        hdrs.update(headers)
    data = None
    if raw_body is not None:
        data = raw_body
        if content_type:
            hdrs["Content-Type"] = content_type
    elif body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs["Content-Type"] = "application/json"
    if token:
        hdrs["Authorization"] = token
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = resp.read().decode("utf-8", "replace")
            status = resp.status
            resp_headers = dict(resp.getheaders())
    except urllib.error.HTTPError as exc:
        payload = exc.read().decode("utf-8", "replace")
        status = exc.code
        resp_headers = dict(exc.getheaders())
    try:
        parsed = json.loads(payload) if payload else {}
    except ValueError:
        parsed = {"_raw": payload[:500]}
    return status, parsed, resp_headers


def check(name, cond, detail=""):
    if cond:
        PASS.append(name)
        print("  ✅ %s" % name)
    else:
        FAIL.append((name, detail))
        print("  ❌ %s  %s" % (name, detail))


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def multipart(fields, filename, content, content_type="application/octet-stream"):
    boundary = "----reconlab" + uuid.uuid4().hex
    lines = []
    for key, value in fields.items():
        lines.append(("--%s\r\n" % boundary).encode())
        lines.append(('Content-Disposition: form-data; name="%s"\r\n\r\n' % key).encode())
        lines.append(("%s\r\n" % value).encode())
    lines.append(("--%s\r\n" % boundary).encode())
    lines.append(('Content-Disposition: form-data; name="file"; filename="%s"\r\n' % filename).encode())
    lines.append(("Content-Type: %s\r\n\r\n" % content_type).encode())
    lines.append(content)
    lines.append(("\r\n--%s--\r\n" % boundary).encode())
    return b"".join(lines), "multipart/form-data; boundary=%s" % boundary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8090")
    parser.add_argument("--email", default="admin@reconlab.local")
    parser.add_argument("--password", default="reconlab123")
    parser.add_argument("--keep", action="store_true", help="保留测试数据不清理")
    args = parser.parse_args()
    base = args.url.rstrip("/")

    status, payload, _ = http("POST", base + "/api/collections/_superusers/auth-with-password",
                              {"identity": args.email, "password": args.password})
    if status != 200:
        print("管理员登录失败: %s %s" % (status, payload))
        return 1
    admin = payload["token"]

    tag = uuid.uuid4().hex[:6]
    host = "e2e-%s.contract-test.example" % tag
    agent_key = "rlk_" + uuid.uuid4().hex + uuid.uuid4().hex[:8]

    # 准备：Agent 身份 + 授权范围
    status, agent, _ = http("POST", base + "/api/collections/agents/records", {
        "name": "e2e-agent-%s" % tag,
        "identity": "e2e@reconlab.local",
        "scopes": "ingest,review",
        "status": "online",
        "api_key_hash": sha256_hex(agent_key.encode()),
        "key_prefix": agent_key[:16],
    }, token=admin)
    if status not in (200, 201):
        print("建测试 Agent 失败: %s %s" % (status, agent))
        return 1
    agent_id = agent["id"]

    later = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 3600))
    status, scope, _ = http("POST", base + "/api/collections/scopes/records", {
        "name": "e2e-scope-%s" % tag,
        "assets": [
            {"type": "domain", "value": "%s" % host},
            {"type": "ip_cidr", "value": "10.99.0.0/24"},
            {"type": "url_prefix", "value": "https://%s/v1/" % host},
        ],
        "status": "active",
        "authorized_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 60)),
        "expires_at": later,
        "authorization_reference": "E2E-TEST",
    }, token=admin)
    if status not in (200, 201):
        print("建测试范围失败: %s %s" % (status, scope))
        return 1
    scope_id = scope["id"]

    AUTH = {"Authorization": "Bearer " + agent_key}
    created_ids = []

    try:
        print("\n【1】鉴权")
        st, body, _ = http("GET", base + "/api/verification/queue")
        check("无 key → 401", st == 401, "got %s %s" % (st, body.get("code")))
        st, body, _ = http("GET", base + "/api/verification/queue", headers={"Authorization": "Bearer rlk_bogus"})
        check("错 key → 401 AGENT_KEY_INVALID", st == 401 and body.get("code") == "AGENT_KEY_INVALID", str(body)[:200])
        st, body, _ = http("GET", base + "/api/verification/queue", headers=AUTH)
        check("对 key → 200", st == 200 and "items" in body, str(body)[:200])
        st, body, _ = http("GET", base + "/api/contract/meta", headers=AUTH)
        check("契约自描述可取（词表/映射/限制）",
              st == 200 and body.get("contract_version") == 2 and body.get("states", {}).get("external"),
              str(body)[:200])

        st, body, _ = http("GET", base + "/api/verification/queue", headers=dict(AUTH, **{"X-Contract-Version": "1"}))
        check("契约版本声明 v1 → 400 CONTRACT_VERSION_UNSUPPORTED",
              st == 400 and body.get("code") == "CONTRACT_VERSION_UNSUPPORTED", str(body)[:200])

        print("\n【2】授权范围（scope_id 不是凭证，服务端现算）")
        out_of_scope = {"kind": "open_redirect", "target": "evil.example.com",
                        "endpoint": "https://evil.example.com/go?next=x"}
        st, body, _ = http("POST", base + "/api/verification/queue", out_of_scope,
                           headers=dict(AUTH, **{"Idempotency-Key": str(uuid.uuid4())}))
        check("范围外上报 → 403 OUT_OF_SCOPE", st == 403 and body.get("code") == "OUT_OF_SCOPE", str(body)[:200])

        st, body, _ = http("POST", base + "/api/verification/queue",
                           dict(out_of_scope, scope_id=scope_id),
                           headers=dict(AUTH, **{"Idempotency-Key": str(uuid.uuid4())}))
        check("伪造 scope_id 也拦（现算不匹配）→ 403", st == 403, str(body)[:200])

        st, body, _ = http("POST", base + "/api/verification/queue",
                           {"kind": "open_redirect", "target": "not" + host,
                            "endpoint": "https://not%s/go" % host},
                           headers=dict(AUTH, **{"Idempotency-Key": str(uuid.uuid4())}))
        check("点边界域名匹配（notdemo.test 不算 in scope）→ 403", st == 403, str(body)[:200])

        st, body, _ = http("POST", base + "/api/scope/check", {
            "urls": ["https://%s/go?next=/a" % host, "https://evil.example.com/x"],
        }, headers=AUTH)
        check("重定向逐跳校验：一跳在内一跳在外 → 403 且逐跳给结果",
              st == 403 and body.get("hop_count") == 2 and body["results"][0]["in_scope"]
              and not body["results"][1]["in_scope"], str(body)[:260])

        print("\n【3】上报 + 幂等（幂等键必须客户端生成、重试原样复用）")
        idem_key = str(uuid.uuid4())
        payload_in = {
            "kind": "open_redirect",
            "target": host,
            "endpoint": "https://%s:443/go?next=%%2Fhome" % host.upper(),
            "parameter": "next",
            "location": "query",
            "severity": "medium",
            "confidence": 40,
            "title": "开放重定向候选",
            "raw_request": "GET /go?next=//evil HTTP/1.1",
            "raw_response": "HTTP/1.1 302 Found",
            "curl": "curl -i 'https://%s/go?next=//evil'" % host,
        }
        st, body, hdrs = http("POST", base + "/api/verification/queue", payload_in,
                              headers=dict(AUTH, **{"Idempotency-Key": idem_key}))
        ok_create = st == 201
        item = body.get("item", {})
        created_ids.append(item.get("id"))
        check("范围内上报 → 201 + 契约字段齐全",
              ok_create and item.get("state") == "suspected" and item.get("etag") and item.get("rev") == 1,
              str(body)[:260])
        check("端点规范化（大写/默认端口/query 被剥掉）",
              item.get("endpoint") == "https://%s/go" % host, str(item.get("endpoint")))
        check("location 字段落库（IDOR/越权能表述参数在哪）", item.get("location") == "query", str(item.get("location")))

        st, body2, hdrs2 = http("POST", base + "/api/verification/queue", payload_in,
                                headers=dict(AUTH, **{"Idempotency-Key": idem_key}))
        check("同 key 同内容重放 → 回放首次结果，不新建",
              st in (200, 201) and body2.get("item", {}).get("id") == item.get("id")
              and hdrs2.get("Idempotent-Replay") == "true", str(body2)[:200])

        st, body3, _ = http("POST", base + "/api/verification/queue", dict(payload_in, severity="high"),
                            headers=dict(AUTH, **{"Idempotency-Key": idem_key}))
        check("同 key 不同内容 → 409 IDEMPOTENCY_CONFLICT",
              st == 409 and body3.get("code") == "IDEMPOTENCY_CONFLICT", str(body3)[:200])

        st, body4, _ = http("POST", base + "/api/verification/queue", payload_in, headers=AUTH)
        check("缺 Idempotency-Key → 400", st == 400 and body4.get("code") == "IDEMPOTENCY_KEY_REQUIRED",
              str(body4)[:200])

        st, body5, _ = http("POST", base + "/api/verification/queue", payload_in,
                            headers=dict(AUTH, **{"Idempotency-Key": str(uuid.uuid4())}))
        check("同内容不同 key → 去重合并（instances+1），同一条 id",
              st == 200 and body5.get("deduplicated") is True
              and body5.get("item", {}).get("id") == item.get("id"), str(body5)[:220])

        print("\n【4】领取 / 租约 / 心跳")
        st, body, _ = http("GET", base + "/api/verification/queue?state=suspected&limit=50", headers=AUTH)
        found = any(i["id"] == item["id"] for i in body.get("items", []))
        check("拉队列 state=suspected 能拿到", st == 200 and found, str(body)[:200])

        st, claim, _ = http("POST", base + "/api/verification/queue/%s/claim" % item["id"],
                            {"worker_id": "e2e-worker-1", "lease_seconds": 120}, headers=AUTH)
        token = claim.get("lease_token")
        check("claim → 拿到 lease_token + 到期时间", st == 200 and token and claim.get("lease_expires_at"),
              str(claim)[:220])

        st, det, _ = http("GET", base + "/api/verification/queue/%s" % item["id"], headers=AUTH)
        det_item = det.get("item", {})
        check("单条 GET（只读）→ 200 + etag 与上报时同源",
              st == 200 and det_item.get("etag") == item.get("etag") and det_item.get("id") == item["id"],
              str(det)[:240])
        check("单条 GET 不推 rev（领取推不动内容版本）",
              det_item.get("rev") == item.get("rev"), "rev=%s" % det_item.get("rev"))
        check("单条 GET 能看到租约状态、但不改它",
              det_item.get("lease", {}).get("active") is True, str(det_item.get("lease")))

        st, cached, _ = http("GET", base + "/api/verification/queue/%s" % item["id"],
                             headers=dict(AUTH, **{"If-None-Match": item["etag"]}))
        check("If-None-Match 命中当前版本 → 304 空体", st == 304, "st=%s %s" % (st, str(cached)[:140]))

        st, noauth, _ = http("GET", base + "/api/verification/queue/%s" % item["id"])
        check("单条 GET 不带 Key → 401", st == 401, str(noauth)[:160])

        st, miss, _ = http("GET", base + "/api/verification/queue/no-such-item-xyz", headers=AUTH)
        check("单条 GET 记录不存在 → 404 NOT_FOUND",
              st == 404 and miss.get("code") == "NOT_FOUND", str(miss)[:160])

        st, again, _ = http("POST", base + "/api/verification/queue/%s/claim" % item["id"],
                            {"worker_id": "e2e-worker-2", "lease_seconds": 120}, headers=AUTH)
        check("别人再 claim → 409 ALREADY_CLAIMED",
              st == 409 and again.get("code") == "ALREADY_CLAIMED", str(again)[:200])

        st, listed, _ = http("GET", base + "/api/verification/queue?state=testing&limit=50", headers=AUTH)
        check("被领走的记录对外是 testing",
              any(i["id"] == item["id"] and i["lease"]["active"] for i in listed.get("items", [])),
              str(listed)[:200])

        st, hb, _ = http("POST", base + "/api/verification/queue/%s/heartbeat" % item["id"],
                         {"lease_token": token, "lease_seconds": 300}, headers=AUTH)
        check("心跳续租 → 200", st == 200 and hb.get("lease_expires_at"), str(hb)[:200])

        print("\n【5】证据通道（两步式 + 服务端自算摘要比对）")
        evidence_bytes = b"RAW HTTP EXCHANGE e2e\nGET /go?next=//evil HTTP/1.1\n" + uuid.uuid4().bytes
        ev_hash = sha256_hex(evidence_bytes)
        digest_b64 = base64.b64encode(bytes.fromhex(ev_hash)).decode()
        ev_body = {
            "content_base64": base64.b64encode(evidence_bytes).decode(),
            "content_type": "text/plain",
            "kind": "http_exchange",
            "note": "e2e",
            "filename": "exchange.txt",
        }
        st, ev, _ = http("POST", base + "/api/evidence", ev_body,
                         headers=dict(AUTH, **{"Content-Digest": "sha-256=:%s:" % digest_b64}))
        ev_id = ev.get("evidence", {}).get("id")
        check("上传（带 Content-Digest）→ 201 且自算摘要一致（含落盘回读校验）",
              st == 201 and ev.get("digest_verified") is True
              and ev["evidence"]["sha256"] == ev_hash, str(ev)[:300])

        st, ev2, _ = http("POST", base + "/api/evidence", ev_body,
                          headers=dict(AUTH, **{"Content-Digest": "sha-256=:%s:" % digest_b64}))
        check("同内容重复上传 → 内容寻址复用同一个 evidence.id",
              st in (200, 201) and ev2.get("deduplicated") is True
              and ev2["evidence"]["id"] == ev_id, str(ev2)[:220])

        st, ev3, _ = http("POST", base + "/api/evidence", ev_body,
                          headers=dict(AUTH, **{"Content-Digest": "sha-256=:%s:" % base64.b64encode(b"\x00" * 32).decode()}))
        check("摘要不符 → 400 DIGEST_MISMATCH 且拒收",
              st == 400 and ev3.get("code") == "DIGEST_MISMATCH", str(ev3)[:220])

        st, ev4, _ = http("POST", base + "/api/evidence",
                          {"content_base64": base64.b64encode(evidence_bytes).decode()}, headers=AUTH)
        check("不带摘要 → 400 DIGEST_REQUIRED", st == 400 and ev4.get("code") == "DIGEST_REQUIRED", str(ev4)[:200])

        st, meta_ev, _ = http("GET", base + "/api/evidence/%s" % ev_id, headers=AUTH)
        check("证据元数据可取（含 sha256 / size / file_url）",
              st == 200 and meta_ev["evidence"]["sha256"] == ev_hash, str(meta_ev)[:220])

        st, dl, _ = http("GET", base + "/api/evidence/%s/raw" % ev_id, headers=AUTH)
        ok_dl = False
        if st == 200:
            back = base64.b64decode(dl.get("content_base64", ""))
            ok_dl = back == evidence_bytes and dl.get("sha256_match") is True
        check("证据下载回来字节完全一致（sha256_match=true）", st == 200 and ok_dl, str(dl)[:200])

        print("\n【6】乐观锁 + 判定准则")
        etag = item["etag"]
        st, body_stale, _ = http("PATCH", base + "/api/verification/queue/%s" % item["id"],
                                 {"state": "confirmed", "verdict_note": "x"},
                                 headers=dict(AUTH, **{"If-Match": '"wrong-etag"'}))
        check("If-Match 不匹配 → 412 PRECONDITION_FAILED",
              st == 412 and body_stale.get("code") == "PRECONDITION_FAILED", str(body_stale)[:200])

        st, body_no_if, _ = http("PATCH", base + "/api/verification/queue/%s" % item["id"],
                                 {"state": "confirmed"}, headers=AUTH)
        check("不带 If-Match → 428 PRECONDITION_REQUIRED",
              st == 428 and body_no_if.get("code") == "PRECONDITION_REQUIRED", str(body_no_if)[:200])

        st, body_rubric, _ = http("PATCH", base + "/api/verification/queue/%s" % item["id"],
                                  {"state": "confirmed", "verdict_note": "没证据也想过", "lease_token": token},
                                  headers=dict(AUTH, **{"If-Match": etag}))
        check("confirmed 缺复现步骤/证据 → 422 RUBRIC_VIOLATION",
              st == 422 and body_rubric.get("code") == "RUBRIC_VIOLATION", str(body_rubric)[:260])

        st, body_verdict, _ = http("PATCH", base + "/api/verification/queue/%s" % item["id"], {
            "state": "confirmed",
            "verdict_note": "对照组未跳转，试验组 302 到站外，确认开放重定向",
            "reproduction_steps": [
                "GET /go?next=https%3A%2F%2Fevil.example → 302 Location: https://evil.example",
                "对照组 next=/local 仅站内跳转",
            ],
            "confidence": 90,
            "evidence": [{"id": ev_id, "sha256": sha256_hex(evidence_bytes)}],
            "lease_token": token,
            "checks": [{"id": "reproduce", "state": "pass"}, {"id": "control", "state": "pass"}],
        }, headers=dict(AUTH, **{"If-Match": etag}))
        check("带证据回写 confirmed → 200，对外 confirmed + 平台复核位仍在",
              st == 200 and body_verdict["item"]["state"] == "confirmed"
              and body_verdict["item"]["review_status"] == "pending_platform_review",
              str(body_verdict)[:300])

        print("\n【7】租约回收后旧 token 立即作废")
        st, claim2, _ = http("POST", base + "/api/verification/queue/%s/claim" % item["id"],
                             {"worker_id": "e2e-worker-1", "lease_seconds": 60},
                             headers=dict(AUTH, **{"Idempotency-Key": str(uuid.uuid4())}))
        stale_token = claim2.get("lease_token")
        check("终态记录不允许再 claim", st == 409 and claim2.get("code") == "ALREADY_FINAL", str(claim2)[:200])

        print("\n【8】scope 中途失效 → 任务作废")
        st, _, _ = http("PATCH", base + "/api/collections/scopes/records/%s" % scope_id,
                        {"expires_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 10))},
                        token=admin)
        st, abort, _ = http("POST", base + "/api/verification/queue/%s/claim" % item["id"],
                            {"worker_id": "e2e-worker-9", "lease_seconds": 60}, headers=AUTH)
        check("范围过期后 claim → 409 SCOPE_EXPIRED（三点都校验）",
              st == 409 and abort.get("code") == "SCOPE_EXPIRED", str(abort)[:220])

        st, _, _ = http("PATCH", base + "/api/collections/scopes/records/%s" % scope_id,
                        {"expires_at": later}, token=admin)

        print("\n【9】终态不可原地回退 + supersedes 重开链")
        reopen_payload = {
            "kind": "open_redirect",
            "target": host,
            "endpoint": "https://%s/go?next=//evil" % host,
            "parameter": "next",
            "state": "suspected",
            "supersedes": item["id"],
            "reopened_reason": "站上新加了 WAF，原结论需要复测",
        }
        st, reopened, _ = http("POST", base + "/api/verification/queue", reopen_payload,
                               headers=dict(AUTH, **{"Idempotency-Key": str(uuid.uuid4())}))
        new_item = reopened.get("item", {})
        created_ids.append(new_item.get("id"))
        check("supersedes 重开 → 新记录带 supersedes，老的被冻结",
              st == 201 and new_item.get("supersedes") == item["id"], str(reopened)[:240])

        st, old_after, _ = http("GET", base + "/api/verification/queue?state=confirmed&limit=50", headers=AUTH)
        old_view = next((i for i in old_after.get("items", []) if i["id"] == item["id"]), None)
        check("老记录 superseded_by 已回填（证据链不断）",
              old_view is not None and old_view.get("superseded_by") == new_item.get("id"),
              str(old_view)[:220])

        st, frozen, _ = http("PATCH", base + "/api/verification/queue/%s" % item["id"],
                             {"state": "rejected", "verdict_note": "x"},
                             headers=dict(AUTH, **{"If-Match": old_view.get("etag") if old_view else '"x"'}))
        check("对已取代记录回写 → 409 ALREADY_SUPERSEDED",
              st == 409 and frozen.get("code") == "ALREADY_SUPERSEDED", str(frozen)[:220])

        print("\n【10】判定准则表 & 契约元信息")
        st, rubrics, _ = http("GET", base + "/api/rubrics", headers=AUTH)
        check("判定准则表可取（含 open_redirect / sql_injection 门槛）",
              st == 200 and any(r["kind"] == "open_redirect" and r["min_confidence"] for r in rubrics.get("items", [])),
              str(rubrics)[:200])
        st, one, _ = http("GET", base + "/api/rubrics/sql_injection", headers=AUTH)
        check("单个 kind 的准则可取（时间盲注要二轮复核这类硬要求在里面）",
              st == 200 and "reproduce" in one["rubric"]["confirm_checks"], str(one)[:200])

        print("\n【12】租约超时回收：旧 token 立即作废（A 超时 B 领走，A 不能再写）")
        st, fresh, _ = http("POST", base + "/api/verification/queue", {
            "kind": "reflected_xss", "target": host,
            "endpoint": "https://%s/search?q=1" % host,
            "parameter": "q", "location": "query", "severity": "high",
        }, headers=dict(AUTH, **{"Idempotency-Key": str(uuid.uuid4())}))
        lease_item = fresh.get("item", {})
        created_ids.append(lease_item.get("id"))
        st, c1, _ = http("POST", base + "/api/verification/queue/%s/claim" % lease_item["id"],
                         {"worker_id": "worker-A", "lease_seconds": 60}, headers=AUTH)
        old_token = c1.get("lease_token")
        check("A 领取成功", st == 200 and old_token, str(c1)[:160])

        # 把租约时间改到过去，模拟 A 超时
        http("PATCH", base + "/api/collections/review_queue/records/%s" % lease_item["id"],
             {"lease_expires_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 30))},
             token=admin)

        st, c2, _ = http("POST", base + "/api/verification/queue/%s/claim" % lease_item["id"],
                         {"worker_id": "worker-B", "lease_seconds": 60}, headers=AUTH)
        new_token = c2.get("lease_token")
        check("超时后 B 能重新领走（惰性回收）", st == 200 and new_token and new_token != old_token, str(c2)[:200])

        st, denied, _ = http("PATCH", base + "/api/verification/queue/%s" % lease_item["id"], {
            "state": "confirmed", "verdict_note": "A 拿着老 token 抢写", "confidence": 80,
            "reproduction_steps": ["x"], "evidence": [{"id": ev_id}], "lease_token": old_token,
        }, headers=dict(AUTH, **{"If-Match": c1["item"]["etag"] if c1.get("item") else '"x"'}))
        check("A 用旧 token 提交 → 409 LEASE_EXPIRED（老租约立即作废）",
              st == 409 and denied.get("code") == "LEASE_EXPIRED", str(denied)[:220])

        st, okB, _ = http("POST", base + "/api/verification/queue/%s/release" % lease_item["id"],
                          {"lease_token": new_token, "reason": "e2e"}, headers=AUTH)
        check("B 主动释放 → 200 且退回待验证", st == 200 and okB["item"]["state"] == "suspected", str(okB)[:200])

        print("\n【11】限流 429 + Retry-After")
        got_429 = None
        for _ in range(70):
            st, body, hdrs = http("GET", base + "/api/scopes", headers=AUTH)
            if st == 429:
                got_429 = hdrs
                break
        check("超限 → 429 且带 Retry-After", got_429 is not None and got_429.get("Retry-After"),
              str(got_429)[:200])

    finally:
        if not args.keep:
            for rid in created_ids:
                if rid:
                    http("DELETE", base + "/api/collections/review_queue/records/%s" % rid, token=admin)
            http("DELETE", base + "/api/collections/scopes/records/%s" % scope_id, token=admin)
            http("DELETE", base + "/api/collections/agents/records/%s" % agent_id, token=admin)

    print("\n" + "=" * 60)
    print("通过 %d 项 / 失败 %d 项" % (len(PASS), len(FAIL)))
    for name, detail in FAIL:
        print("  ❌ %s | %s" % (name, detail[:220]))
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(main())
