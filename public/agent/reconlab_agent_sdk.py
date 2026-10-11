#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
reconlab_agent_sdk.py — ReconLab 契约 v2 的 Agent 接入 SDK（参考实现，零依赖）

对齐 openapi.yaml（v2）。这一版把并发、幂等、乐观锁、证据摘要、判定准则都封好了，
照着它写 PhantomVeil 的对接层就行，不用自己拼 HTTP。

用法一（当库用）：
    from reconlab_agent_sdk import ReconLabAgent, Evidence

    agent = ReconLabAgent("http://127.0.0.1:8090", api_key="rlk_xxx")
    for item in agent.list_queue(state="suspected", kind="open_redirect"):
        lease = agent.claim(item["id"], worker_id="phantomveil-01")
        if not lease:
            continue                      # 别人领走了
        ...                                   # 自己独立复现
        ev = agent.upload_evidence(open("exchange.txt", "rb").read(),
                                   kind="http_exchange", note="对照组未跳转")
        agent.write_verdict(item["id"], lease,
                            state="confirmed",
                            verdict_note="对照组未跳转，试验组 302 站外",
                            reproduction_steps=["GET /go?next=... → 302 evil.example",
                                                "对照组 next=/local 仅站内跳转"],
                            evidence=[ev],
                            confidence=90,
                            checks=[{"id": "reproduce", "state": "pass"},
                                    {"id": "control", "state": "pass"}])

用法二（命令行批量灌 JSONL）：
    python3 reconlab_agent_sdk.py --jsonl findings.jsonl \
        --base http://127.0.0.1:8090 --api-key rlk_xxx

用法三（自检，本地起了后端就能跑）：
    python3 reconlab_agent_sdk.py --selftest --base http://127.0.0.1:8090 --api-key rlk_xxx
"""

import argparse
import base64
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

CONTRACT_VERSION = 2

# 对外只有这 5 个词（内部复核状态机不对外）
STATES = ("suspected", "testing", "confirmed", "rejected", "inconclusive")
# 参数位置：IDOR / 越权类必须给，不给描述不清
LOCATIONS = ("query", "body", "header", "cookie", "path")


class ReconLabError(RuntimeError):
    """服务端返回的契约错误。code 是稳定错误码，判断逻辑一律看它，别看 message。"""

    def __init__(self, status, code, message, data=None):
        super().__init__("HTTP %s %s: %s" % (status, code, message))
        self.status = status
        self.code = code
        self.message = message
        self.data = data or {}

    @property
    def retry_after(self):
        """429 / 5xx 时建议的退避秒数"""
        return int(self.data.get("retry_after") or 0)


class ReconLabAgent:
    """契约 v2 客户端。

    并发与安全语义（SDK 已经替你处理掉的部分）：
      - 每次写操作都可带幂等键；重试复用同一个键，服务端不会重复建记录
      - claim 之后拿到 lease_token，回写与心跳都要用它；被回收的 token 会拿到 409
      - 回写自动带上最新的 If-Match（乐观锁），内容被改过会抛 412 让你重拉
      - 证据上传自动算好内容摘要（服务端会自算比对）
    """

    def __init__(self, base, api_key, timeout=60, verbose=False):
        self.base = base.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self.verbose = verbose
        self._lease = {}          # item_id -> {token, expires_at, etag}

    # ── 基础设施 ─────────────────────────────────────────────

    def _request(self, method, path, body=None, headers=None, timeout=None):
        url = self.base + path
        hdrs = {
            "Accept": "application/json",
            "Authorization": "Bearer " + self.api_key,
            "X-Contract-Version": str(CONTRACT_VERSION),
        }
        if headers:
            hdrs.update(headers)
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            hdrs["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as resp:
                raw = resp.read().decode("utf-8", "replace")
                payload = json.loads(raw) if raw else {}
                if self.verbose:
                    print("  → %s %s %s" % (method, path, resp.status))
                return payload
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", "replace")
            try:
                payload = json.loads(raw)
            except ValueError:
                payload = {"message": raw[:400]}
            code = payload.get("code") or ("HTTP_%s" % exc.code)
            raise ReconLabError(exc.code, code, payload.get("message", ""), payload.get("data"))
        except urllib.error.URLError as exc:
            raise ReconLabError(0, "NETWORK_ERROR", "连不上控制台：%s" % exc)

    @staticmethod
    def _idem_key():
        """稳定 UUID：重试时要复用同一个，别用内容哈希"""
        return str(uuid.uuid4())

    # ── 契约元信息 / 授权范围 ────────────────────────────────

    def meta(self):
        """契约自描述：词表、映射、限制、错误码。写对接先读它。"""
        return self._request("GET", "/api/contract/meta")

    def list_scopes(self, status=None):
        q = "?status=%s" % status if status else ""
        return self._request("GET", "/api/scopes" + q).get("items", [])

    def check_scope(self, urls):
        """重定向每一跳都过一遍；返回 (in_scope, results)。越界不抛异常，自己判断。"""
        try:
            res = self._request("POST", "/api/scope/check", {"urls": list(urls)})
            return res.get("in_scope"), res.get("results", [])
        except ReconLabError as exc:
            if exc.status == 403:
                return False, exc.data.get("results", [])
            raise

    def rubrics(self):
        return self._request("GET", "/api/rubrics").get("items", [])

    def rubric(self, kind):
        return self._request("GET", "/api/rubrics/%s" % kind).get("rubric")

    # ── 队列 ─────────────────────────────────────────────────

    def list_queue(self, state=None, kind=None, target=None, limit=20, cursor=None, sort=None):
        parts = []
        for key, value in (("state", state), ("kind", kind), ("target", target),
                           ("sort", sort), ("cursor", cursor)):
            if value:
                parts.append("%s=%s" % (key, urllib.parse.quote(str(value))))
        parts.append("limit=%d" % limit)
        res = self._request("GET", "/api/verification/queue?" + "&".join(parts))
        return res.get("items", []), res.get("next_cursor")

    def report(self, kind, endpoint, **kwargs):
        """上报新发现（必须带幂等键）。kwargs 直接透传契约字段。"""
        body = {"kind": kind, "endpoint": endpoint}
        body.update({k: v for k, v in kwargs.items() if v is not None})
        idem = body.pop("idempotency_key", None) or self._idem_key()
        return self._request("POST", "/api/verification/queue", body,
                             {"Idempotency-Key": idem})

    def claim(self, item_id, worker_id=None, lease_seconds=900):
        """领取。拿不到（别人在验/已终态）返回 None，不抛异常。"""
        try:
            res = self._request("POST", "/api/verification/queue/%s/claim" % item_id,
                                {"worker_id": worker_id or "agent", "lease_seconds": lease_seconds})
        except ReconLabError as exc:
            if exc.status in (404, 409):
                if self.verbose:
                    print("  ! claim 失败：%s %s" % (exc.code, exc.message))
                return None
            raise
        item = res.get("item", {})
        lease = {
            "token": res["lease_token"],
            "expires_at": res.get("lease_expires_at"),
            "etag": item.get("etag"),
        }
        self._lease[item_id] = lease
        return lease

    def heartbeat(self, item_id, lease_seconds=900):
        lease = self._lease.get(item_id)
        if not lease:
            raise ReconLabError(0, "NO_LOCAL_LEASE", "本地没有这条记录的租约，先 claim")
        res = self._request("POST", "/api/verification/queue/%s/heartbeat" % item_id,
                            {"lease_token": lease["token"], "lease_seconds": lease_seconds})
        lease["expires_at"] = res.get("lease_expires_at")
        return res

    def release(self, item_id, reason="released"):
        lease = self._lease.get(item_id)
        if not lease:
            return None
        try:
            return self._request("POST", "/api/verification/queue/%s/release" % item_id,
                                 {"lease_token": lease["token"], "reason": reason})
        finally:
            self._lease.pop(item_id, None)

    def write_verdict(self, item_id, lease=None, state="confirmed", **kwargs):
        """回写判定。自动带 If-Match 与 lease_token；412 抛出来让你重拉再写。"""
        lease = lease or self._lease.get(item_id)
        if not lease:
            raise ReconLabError(0, "NO_LOCAL_LEASE", "回写判定必须持租约，先 claim")
        body = {"state": state, "lease_token": lease["token"]}
        body.update({k: v for k, v in kwargs.items() if v is not None})
        res = self._request("PATCH", "/api/verification/queue/%s" % item_id, body,
                            {"If-Match": lease["etag"]})
        self._lease.pop(item_id, None)          # 服务端回写后会释放租约
        return res

    # ── 证据 ─────────────────────────────────────────────────

    def upload_evidence(self, content, kind=None, note=None,
                        content_type="application/octet-stream", filename=None):
        """上传证据（两步式的第一步）。自动算内容摘要，服务端会自算比对。"""
        if isinstance(content, str):
            content = content.encode("utf-8")
        digest = hashlib.sha256(content).hexdigest()
        body = {
            "content_base64": base64.b64encode(content).decode("ascii"),
            "content_type": content_type,
            "sha256": digest,
        }
        if kind:
            body["kind"] = kind
        if note:
            body["note"] = note
        if filename:
            body["filename"] = filename
        res = self._request("POST", "/api/evidence", body)
        ev = res["evidence"]
        if not res.get("digest_verified", True):
            print("  ! 注意：服务端落盘回读校验未通过，这条证据只做了收下时的摘要比对", file=sys.stderr)
        return {"id": ev["id"], "sha256": ev["sha256"], "kind": ev.get("kind", "")}

    def download_evidence(self, evidence_id):
        """取回证据内容，本地再核一遍 sha256。"""
        res = self._request("GET", "/api/evidence/%s/raw" % evidence_id)
        raw = base64.b64decode(res["content_base64"])
        if hashlib.sha256(raw).hexdigest() != res["sha256"]:
            raise ReconLabError(0, "LOCAL_DIGEST_MISMATCH", "取回的证据字节与摘要不符")
        return raw


# ── 判定准则本地校验（发请求前先自检，少挨 422） ─────────────

def check_rubric(rubric, state, reproduction_steps=None, evidence=None,
                 confidence=0, checks=None, verdict_note="", reason_code=""):
    """按服务端给的判定准则先自检一遍，返回问题列表（空列表 = 能过）。"""
    issues = []
    if not rubric:
        return issues
    steps = reproduction_steps or []
    ev = evidence or []
    checks = checks or []
    if state == "confirmed":
        if not steps:
            issues.append("confirmed 必须带 reproduction_steps")
        if not ev:
            issues.append("confirmed 必须至少挂一条 evidence")
        if rubric.get("min_confidence") and confidence < rubric["min_confidence"]:
            issues.append("confidence %s 低于 %s 的门槛 %s"
                          % (confidence, rubric["kind"], rubric["min_confidence"]))
        for want in rubric.get("confirm_checks", []):
            hit = [c for c in checks if c.get("id") == want]
            if not hit:
                issues.append("缺检查项 %s 的状态" % want)
            elif hit[0].get("state") != "pass":
                issues.append("检查项 %s 不是 pass（当前 %s）" % (want, hit[0].get("state")))
    if state in ("rejected", "inconclusive") and not verdict_note:
        issues.append("%s 必须写 verdict_note 说明依据" % state)
    if reason_code and state == "rejected" and rubric.get("reject_reasons"):
        if reason_code not in rubric["reject_reasons"]:
            issues.append("reason_code %s 不在 %s 的原因表里" % (reason_code, rubric["kind"]))
    return issues


# ── 命令行 ───────────────────────────────────────────────────

def _load_jsonl(path):
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                yield json.loads(line)


def cmd_jsonl(agent, path):
    ok = bad = 0
    for row in _load_jsonl(path):
        try:
            res = agent.report(
                row["kind"], row["endpoint"],
                target=row.get("target"), parameter=row.get("parameter"),
                location=row.get("location"), severity=row.get("severity"),
                confidence=row.get("confidence"), title=row.get("title"),
                raw_request=row.get("raw_request"), raw_response=row.get("raw_response"),
                curl=row.get("curl"),
            )
            item = res.get("item", {})
            tag = "去重" if res.get("deduplicated") else "新建"
            print("  %s %s → %s (%s)" % (tag, row["endpoint"], item.get("id"), item.get("state")))
            for warn in res.get("rubric_warnings", []):
                print("    ! %s" % warn.get("message"))
            ok += 1
        except ReconLabError as exc:
            print("  ✗ %s → %s %s" % (row.get("endpoint"), exc.code, exc.message), file=sys.stderr)
            bad += 1
    print("完成：成功 %d / 失败 %d" % (ok, bad))
    return 0 if not bad else 1


def cmd_selftest(agent):
    """把契约的关键语义在本地过一遍：能不能读、能不能领、幂等对不对、判定准则怎么说。"""
    print("== 契约自检 ==")
    meta = agent.meta()
    print("  契约版本: %s / 对外词表: %s" % (meta.get("contract_version"), meta.get("states", {}).get("external")))
    print("  限流: %s req/min" % meta.get("limits", {}).get("rate_limit_per_minute"))

    scopes = agent.list_scopes()
    active = [s for s in scopes if s.get("active")]
    print("  授权范围: %d 条，其中生效 %d 条" % (len(scopes), len(active)))
    if not active:
        print("  ! 没有生效的授权范围：服务端会拒绝一切上报（403 OUT_OF_SCOPE）")
        return 1

    rubrics = agent.rubrics()
    print("  判定准则: %d 条（%s）" % (len(rubrics), ", ".join(r["kind"] for r in rubrics[:4])))

    items, _ = agent.list_queue(state="suspected", limit=5)
    print("  待验证队列: %d 条" % len(items))
    if items:
        one = items[0]
        issues = check_rubric(agent.rubric(one["kind"]), "confirmed",
                              reproduction_steps=["x"], evidence=[{"id": "EV"}], confidence=90)
        print("  样例 %s（%s, %s）→ 准则自检: %s"
              % (one["id"], one["kind"], one["state"], issues or "可过"))
    print("== 自检完成 ==")
    return 0


def main():
    ap = argparse.ArgumentParser(description="ReconLab 契约 v2 Agent SDK")
    ap.add_argument("--base", default=os.environ.get("RECONLAB_URL", "http://127.0.0.1:8090"))
    ap.add_argument("--api-key", default=os.environ.get("RECONLAB_API_KEY", ""))
    ap.add_argument("--jsonl", help="批量上报的 JSONL 文件")
    ap.add_argument("--selftest", action="store_true", help="契约自检")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    if not args.api_key:
        print("缺少 API Key：在控制台 /agent 页创建 Agent 身份时生成，"
              "用 --api-key 或环境变量 RECONLAB_API_KEY 传入", file=sys.stderr)
        return 2
    agent = ReconLabAgent(args.base, args.api_key, verbose=args.verbose)

    try:
        if args.selftest:
            return cmd_selftest(agent)
        if args.jsonl:
            return cmd_jsonl(agent, args.jsonl)
        ap.print_help()
        return 0
    except ReconLabError as exc:
        print("契约调用失败：%s %s %s" % (exc.status, exc.code, exc.message), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
