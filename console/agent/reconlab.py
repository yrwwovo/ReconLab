# -*- coding: utf-8 -*-
"""
ReconLab 契约客户端 —— 编排层碰后端的唯一出口

只认 openapi.yaml 那套：Bearer rlk_ key、If-Match 乐观锁、lease_token 租约、
Idempotency-Key 幂等。所有返回统一成 CallResult，错误码原样带给上层做处置决策。
"""

import json
import urllib.error
import urllib.request


class CallResult(object):
    __slots__ = ("status", "data", "headers", "transport_error", "ms")

    def __init__(self, status, data, headers, transport_error=None, ms=0):
        self.status = status
        self.data = data if isinstance(data, dict) else {}
        self.headers = headers or {}
        self.transport_error = transport_error
        self.ms = ms

    @property
    def code(self):
        """契约错误码（成功时为空串）。"""
        if self.transport_error:
            return "TRANSPORT_ERROR"
        return str(self.data.get("code") or "")

    @property
    def ok(self):
        return self.transport_error is None and 200 <= self.status < 300

    @property
    def item(self):
        it = self.data.get("item")
        return it if isinstance(it, dict) else {}

    @property
    def etag(self):
        """PATCH 用的 etag：响应头优先，其次 body.item.etag，最后 data.current_etag。"""
        if self.headers.get("etag"):
            return self.headers["etag"]
        if self.item.get("etag"):
            return self.item["etag"]
        return str((self.data.get("data") or {}).get("current_etag") or "")

    def brief(self):
        if self.transport_error:
            return {"error": self.transport_error}
        out = {"status": self.status}
        if self.code:
            out["code"] = self.code
        data = self.data.get("data")
        if isinstance(data, dict) and data:
            out["data"] = data
        if self.data.get("message"):
            out["message"] = str(self.data["message"])[:300]
        return out

    def __repr__(self):
        return "<CallResult %s %s>" % (self.status, self.code or "ok")


class ReconLabClient(object):
    def __init__(self, cfg):
        self.cfg = cfg

    # ── 底座 ──

    def call(self, method, path, body=None, headers=None, timeout=None):
        url = self.cfg.reconlab_base_url + path
        hdrs = {"Accept": "application/json"}
        if self.cfg.reconlab_api_key:
            hdrs["Authorization"] = "Bearer " + self.cfg.reconlab_api_key
        if headers:
            hdrs.update({k: v for k, v in headers.items() if v is not None})
        data = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            hdrs["Content-Type"] = "application/json"

        import time
        started = time.time()
        try:
            req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
            with urllib.request.urlopen(req, timeout=timeout or self.cfg.timeout) as resp:
                raw = resp.read().decode("utf-8", "replace")
                status = resp.status
                resp_headers = {k.lower(): v for k, v in resp.getheaders()}
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", "replace")
            status = exc.code
            resp_headers = {k.lower(): v for k, v in exc.getheaders()}
        except Exception as exc:  # 连不上 / 超时 / DNS
            return CallResult(0, {}, {}, "%s: %s" % (type(exc).__name__, exc),
                              int((time.time() - started) * 1000))

        try:
            parsed = json.loads(raw) if raw else {}
        except ValueError:
            parsed = {"_raw": raw[:400]}
        return CallResult(status, parsed, resp_headers, None, int((time.time() - started) * 1000))

    # ── 契约端点 ──

    def queue_list(self, state=None, kind=None, limit=20, sort="-created"):
        qs = ["limit=%d" % limit, "sort=%s" % sort]
        if state:
            qs.append("state=%s" % state)
        if kind:
            qs.append("kind=%s" % kind)
        return self.call("GET", "/api/verification/queue?" + "&".join(qs))

    def item_get(self, item_id):
        """只读预检：拿最新 etag，不推 rev、不碰租约。"""
        return self.call("GET", "/api/verification/queue/" + item_id)

    def claim(self, item_id, worker_id=None, lease_seconds=None):
        return self.call("POST", "/api/verification/queue/%s/claim" % item_id, {
            "worker_id": worker_id or self.cfg.worker_id,
            "lease_seconds": lease_seconds or self.cfg.lease_seconds,
        })

    def heartbeat(self, item_id, lease_token, lease_seconds=None):
        return self.call("POST", "/api/verification/queue/%s/heartbeat" % item_id, {
            "lease_token": lease_token,
            "lease_seconds": lease_seconds or self.cfg.lease_seconds,
        })

    def release(self, item_id, lease_token, reason=""):
        return self.call("POST", "/api/verification/queue/%s/release" % item_id, {
            "lease_token": lease_token, "reason": reason,
        })

    def patch_verdict(self, item_id, payload, if_match, lease_token=None):
        """回写判定。If-Match 与租约由编排层注入，不让模型手写。"""
        body = dict(payload or {})
        if lease_token:
            body["lease_token"] = lease_token
        return self.call("PATCH", "/api/verification/queue/" + item_id, body,
                         {"If-Match": if_match})

    def report_finding(self, payload, idem_key):
        return self.call("POST", "/api/verification/queue", payload, {"Idempotency-Key": idem_key})

    def scope_check(self, urls):
        return self.call("POST", "/api/scope/check", {"urls": urls})

    def rubric(self, kind):
        return self.call("GET", "/api/rubrics/" + kind)

    def contract_meta(self):
        return self.call("GET", "/api/contract/meta")

    def upload_evidence(self, content_b64, sha256, kind, note="", filename="", content_type="text/plain"):
        body = {
            "content_base64": content_b64,
            "sha256": sha256,
            "kind": kind or "raw",
            "note": note or "",
            "filename": filename or "",
            "content_type": content_type,
        }
        return self.call("POST", "/api/evidence", body)
