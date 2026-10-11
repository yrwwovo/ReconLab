# -*- coding: utf-8 -*-
"""
编排层 · 工具注册表

模型只能看见这些工具，每个工具背后都是契约上的一个端点。三条铁律：

  · **If-Match / lease_token 由编排层注入**，模型不许自己写 etag —— 踩这个坑的适配器一堆
  · 每次写之前的状态守卫在 killchain 里，工具自己再复核一遍（双保险）
  · 工具回给模型的东西一律压缩过（长字段截断），别把上下文撑爆
"""

import base64
import hashlib
import json
import time
import urllib.request
import uuid

from . import killchain as KC

MAX_FIELD = 1200


def _clip(value, n=MAX_FIELD):
    if value is None:
        return ""
    s = str(value)
    return s if len(s) <= n else s[:n] + "…[截断 %d 字]" % (len(s) - n)


def _item_view(item):
    """契约 QueueItem 的紧凑视图 —— 只留决策要用的字段。"""
    if not isinstance(item, dict):
        return {}
    ev = item.get("evidence") or []
    return {
        "id": item.get("id"),
        "kind": item.get("kind"),
        "state": item.get("state"),
        "review_status": item.get("review_status"),
        "title": _clip(item.get("title"), 160),
        "target": item.get("target"),
        "endpoint": item.get("endpoint"),
        "parameter": item.get("parameter"),
        "location": item.get("location"),
        "severity": item.get("severity"),
        "confidence": item.get("confidence"),
        "tier": item.get("tier"),
        "origin": item.get("origin"),
        "agent_name": item.get("agent_name"),
        "instances": item.get("instances"),
        "rev": item.get("rev"),
        "etag": item.get("etag"),
        "lease": item.get("lease") or {},
        "supersedes": item.get("supersedes"),
        "superseded_by": item.get("superseded_by"),
        "evidence_count": len(ev) if isinstance(ev, list) else 0,
        "evidence_note": _clip(item.get("evidence_note"), 200),
        "reproduction_steps": item.get("reproduction_steps") or [],
        "checks": item.get("checks") or [],
        "verdict_note": _clip(item.get("verdict_note"), 300),
        "raw_request": _clip(item.get("raw_request"), 400),
        "raw_response": _clip(item.get("raw_response"), 400),
        "created": item.get("created"),
        "updated": item.get("updated"),
    }


# ───────────────────────── 工具定义（喂给模型） ─────────────────────────

def _schema(props, required=None, extra=False):
    return {
        "type": "object",
        "properties": props,
        "required": required if required is not None else list(props.keys()),
        "additionalProperties": bool(extra),
    }


def tool_defs(cfg):
    """OpenAI function-calling 风格的工具表。冻结顺序 = 缓存友好的前缀。"""
    defs = []

    defs.append({
        "type": "function",
        "function": {
            "name": "queue_overview",
            "description": "看验证队列（只用于挑活，真正干活前必须 item_claim）。返回 [] 说明队列空。",
            "parameters": _schema({
                "state": {"type": ["string", "null"], "enum": ["suspected", "testing", "confirmed", "rejected", "inconclusive", None],
                          "description": "只看某个对外状态；null = 全部"},
                "kind": {"type": ["string", "null"], "description": "漏洞类型过滤，如 open_redirect / sql_injection"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 50, "description": "条数"},
            }),
        },
    })

    defs.append({
        "type": "function",
        "function": {
            "name": "item_read",
            "description": "只读预检：拿单条记录的最新内容与 etag（不推 rev、不碰租约）。回写前必须先读一次；"
                           "已被取代的记录照常返回，看 superseded_by。",
            "parameters": _schema({"item_id": {"type": "string"}}),
        },
    })

    defs.append({
        "type": "function",
        "function": {
            "name": "item_claim",
            "description": "显式领取（拿租约）。他人已领 → 409 ALREADY_CLAIMED；终态 → 409 ALREADY_FINAL；"
                           "范围外 → 403/409。同 worker 重复领取会换发新 token（编排层会自动覆盖本地 token）。",
            "parameters": _schema({
                "item_id": {"type": "string"},
                "lease_seconds": {"type": ["integer", "null"], "minimum": 30, "maximum": 3600},
            }),
        },
    })

    defs.append({
        "type": "function",
        "function": {
            "name": "item_heartbeat",
            "description": "续租。干得久（>租约一半）就调一次，别挂到超时被回收。",
            "parameters": _schema({"item_id": {"type": "string"}}),
        },
    })

    defs.append({
        "type": "function",
        "function": {
            "name": "item_release",
            "description": "主动释放：干不完 / 发现不对，把记录退回待验证，让别人能领。",
            "parameters": _schema({
                "item_id": {"type": "string"},
                "reason": {"type": ["string", "null"]},
            }),
        },
    })

    defs.append({
        "type": "function",
        "function": {
            "name": "item_write_verdict",
            "description": "回写判定（唯一写入口）。If-Match 与租约令牌由编排层注入，你不用也不能自己填。"
                           "confirmed 必须带 reproduction_steps + 至少一条证据，并满足该 kind 的判定准则；"
                           "suspected 只能用于非终态；人工签过字的终态要用 finding_report + supersedes 重开。",
            "parameters": _schema({
                "state": {"type": "string", "enum": ["suspected", "testing", "confirmed", "rejected", "inconclusive"]},
                "verdict_note": {"type": ["string", "null"], "description": "中文依据，判定必须写清为什么"},
                "reason_code": {"type": ["string", "null"], "description": "结构化原因码，取值见该 kind 的判定准则"},
                "confidence": {"type": ["integer", "null"], "minimum": 0, "maximum": 100},
                "reproduction_steps": {"type": ["array", "null"], "items": {"type": "string"},
                                       "description": "可复现步骤，confirmed 必填"},
                "checks": {"type": ["array", "null"], "items": {
                    "type": "object",
                    "properties": {"id": {"type": "string"}, "state": {"type": "string"}, "note": {"type": ["string", "null"]}},
                    "required": ["id", "state", "note"], "additionalProperties": False},
                    "description": "复核项状态，如 reproduce/control/cross 的 pass|fail|todo|na"},
                "evidence_ids": {"type": ["array", "null"], "items": {"type": "string"},
                                 "description": "已上传证据的 id（先 evidence_submit）"},
                "curl": {"type": ["string", "null"]},
            }),
        },
    })

    defs.append({
        "type": "function",
        "function": {
            "name": "evidence_submit",
            "description": "上传一条证据（文本），返回 evidence id + sha256，回写判定时放进 evidence_ids。",
            "parameters": _schema({
                "content_text": {"type": "string", "description": "证据原文（请求/响应/命令输出）"},
                "kind": {"type": ["string", "null"], "description": "request / response / screenshot / log / raw"},
                "note": {"type": ["string", "null"]},
            }),
        },
    })

    defs.append({
        "type": "function",
        "function": {
            "name": "rubric_lookup",
            "description": "查某个漏洞类型的判定准则（confirmed/rejected/inconclusive 的门槛）。判之前先看这个。",
            "parameters": _schema({"kind": {"type": "string"}}),
        },
    })

    defs.append({
        "type": "function",
        "function": {
            "name": "scope_check",
            "description": "授权范围校验（重定向要逐跳）。任何要碰目标前都必须先过这一步，硬边界。",
            "parameters": _schema({"urls": {"type": "array", "items": {"type": "string"}}}),
        },
    })

    defs.append({
        "type": "function",
        "function": {
            "name": "finding_report",
            "description": "上报一条新发现（要 Idempotency-Key，编排层自动生成稳定键）。"
                           "要推翻已签字结论：supersedes 填旧记录 id，证据链不断。",
            "parameters": _schema({
                "kind": {"type": "string"},
                "endpoint": {"type": "string", "description": "完整 URL；服务端会规范化"},
                "target": {"type": ["string", "null"]},
                "severity": {"type": ["string", "null"], "enum": ["critical", "high", "medium", "low", "info", None]},
                "confidence": {"type": ["integer", "null"], "minimum": 0, "maximum": 100},
                "title": {"type": ["string", "null"]},
                "parameter": {"type": ["string", "null"]},
                "location": {"type": ["string", "null"], "enum": ["query", "body", "header", "cookie", "path", None]},
                "raw_request": {"type": ["string", "null"]},
                "raw_response": {"type": ["string", "null"]},
                "curl": {"type": ["string", "null"]},
                "supersedes": {"type": ["string", "null"], "description": "要重开的旧记录 id"},
                "reopened_reason": {"type": ["string", "null"]},
            }),
        },
    })

    if cfg.allow_active_probe:
        defs.append({
            "type": "function",
            "function": {
                "name": "http_probe",
                "description": "对范围内目标发一次 GET/HEAD 请求（默认关闭，需显式开启；必须先 scope_check 通过）。",
                "parameters": _schema({
                    "url": {"type": "string"},
                    "method": {"type": ["string", "null"], "enum": ["GET", "HEAD", None]},
                }),
            },
        })

    defs.append({
        "type": "function",
        "function": {
            "name": "finish",
            "description": "结束这一轮：说明做完了什么、剩什么、下一条建议动谁。",
            "parameters": _schema({
                "summary": {"type": "string"},
                "next": {"type": ["string", "null"]},
            }),
        },
    })

    return defs


def strictify(tool):
    """把某个工具的参数 schema 变成 strict 模式可用的形态（递归补 required / 关 additionalProperties）。"""
    def walk(node):
        if not isinstance(node, dict):
            return node
        if node.get("type") == "object" or "properties" in node:
            props = node.get("properties") or {}
            node["properties"] = {k: walk(v) for k, v in props.items()}
            node["required"] = list(props.keys())
            node["additionalProperties"] = False
            return node
        if node.get("type") == "array" and isinstance(node.get("items"), dict):
            node["items"] = walk(node["items"])
            return node
        # 顺手把 strict 不认的约束去掉（minLength / minimum 这类）
        for k in ("minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"):
            node.pop(k, None)
        return node

    out = json.loads(json.dumps(tool))
    out["function"]["parameters"] = walk(out["function"]["parameters"])
    return out


# ───────────────────────── 执行器 ─────────────────────────

class ToolRunner(object):
    def __init__(self, cfg, client, killchain, emit):
        self.cfg = cfg
        self.client = client
        self.kc = killchain
        self.emit = emit                 # emit(kind, payload)
        self.idem_keys = {}              # (kind, hash) → 稳定幂等键，重试原样复用
        self.audit = []

    # ── 幂等键：客户端生成、稳定复用，不用内容哈希当键 ──

    def _idem_key(self, scope, payload):
        sig = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]
        key = self.idem_keys.get((scope, sig))
        if not key:
            key = str(uuid.uuid4())
            self.idem_keys[(scope, sig)] = key
        return key

    # ── 主入口 ──

    def run(self, name, args):
        args = args if isinstance(args, dict) else {}
        started = time.time()
        ctx = self.kc.active
        target_id = str(args.get("item_id") or (ctx.id if ctx else ""))

        # 任何带 item_id 的工具都把工作焦点切过去；切之前把上一条的租约主动还掉
        # （契约：干不完要 release，别挂着等超时）
        if target_id:
            prev = self.kc.active
            if prev is not None and prev.id != target_id and prev.lease_token:
                res = self.client.release(prev.id, prev.lease_token, "编排层切换目标，主动退回")
                self.emit("tool_audit", {"tool": "auto_release", "item_id": prev.id,
                                         "status": res.status, "code": res.code,
                                         "action": "release_on_switch", "ms": res.ms, "args": ""})
                prev.lease_token = ""
            ctx = self.kc.focus(target_id)

        ok, why = self.kc.gate(name, ctx)
        if not ok:
            self._audit(name, args, 0, "GATE_BLOCKED", why, started, target_id)
            return {"ok": False, "blocked": True, "error": why,
                    "hint": "换个动作，或先把前面该做的做了"}

        handler = getattr(self, "_do_" + name, None)
        if handler is None:
            return {"ok": False, "error": "未知工具 %s" % name}

        # 瞬时故障（网络抖动 / 429 限流）在工具层就地退避重试 —— 这是基础设施问题，
        # 不该烧模型的 token 让它去猜"要不要再试一次"。业务级错误（409/412/422）不在这重试。
        out = None
        for attempt in range(3):
            try:
                out = handler(args, ctx)
            except Exception as exc:                 # 工具自身炸了，别把整个会话带崩
                self._audit(name, args, 0, "TOOL_ERROR", str(exc), started, target_id)
                return {"ok": False, "error": "工具执行异常：%s" % exc}
            if out.get("action") != "retry" or attempt == 2:
                break
            wait = ((out.get("result") or {}).get("action") or {}).get("retry_after") or 1.5
            try:
                time.sleep(min(max(float(wait), 0.5), 10))
            except (TypeError, ValueError):
                time.sleep(1.5)
            self.emit("tool_audit", {"tool": name, "item_id": target_id or None, "status": 0,
                                     "code": "TRANSIENT_RETRY", "action": "retry",
                                     "ms": 0, "args": "第 %d 次退避重试" % (attempt + 1)})

        result = out.get("result")
        action = out.get("action")
        self._audit(name, args, (result or {}).get("status", 200), (result or {}).get("code", ""),
                    action, started, target_id)
        return out

    def _audit(self, tool, args, status, code, action, started, item_id):
        rec = {
            "tool": tool,
            "item_id": item_id or None,
            "status": status,
            "code": code or "",
            "action": action or "",
            "ms": int((time.time() - started) * 1000),
            "args": _clip(json.dumps(args, ensure_ascii=False), 600),
        }
        self.audit.append(rec)
        self.emit("tool_audit", rec)

    def _handle_error(self, ctx, res, note=""):
        action = self.kc.decide_on_error(ctx, res)
        return {
            "ok": False,
            "result": {
                "error": res.brief(),
                "action": action.as_dict(),
                "note": note or "按 action 走，别自己发明状态迁移",
            },
            "action": action.kind,
        }

    # ── 具体工具 ──

    def _do_queue_overview(self, args, ctx):
        state = args.get("state") or None
        kind = args.get("kind") or None
        limit = int(args.get("limit") or 10)
        res = self.client.queue_list(state=state, kind=kind, limit=max(1, min(limit, 50)))
        if not res.ok:
            return self._handle_error(None, res)
        items = [_item_view(it) for it in (res.data.get("items") or [])]
        return {"ok": True, "result": {
            "count": res.data.get("count"),
            "next_cursor": res.data.get("next_cursor"),
            "items": items,
            "note": "队列空就先 finding_report 上报，或者等着别人 ingest；空队列开跑必然拿不到东西",
        }}

    def _do_item_read(self, args, ctx):
        item_id = str(args.get("item_id") or "")
        if not item_id:
            return {"ok": False, "error": "缺 item_id"}
        res = self.client.item_get(item_id)
        if not res.ok:
            return self._handle_error(ctx, res)
        view = _item_view(res.item)
        ctx.etag = res.etag or view.get("etag") or ctx.etag
        superseded = str(view.get("superseded_by") or "")
        ctx.superseded_by = superseded
        if ctx.stage in (KC.QUEUED, KC.IDLE):
            ctx.to(KC.PRECHECK, "读了单条详情")
        hint = []
        if superseded:
            hint.append("这条已被 %s 取代：作废记录别往上写，去处理那一条" % superseded)
        lease = view.get("lease") or {}
        if lease.get("active"):
            hint.append("租约在 %s 手上（到 %s）" % (lease.get("holder"), lease.get("expires_at")))
        else:
            hint.append("当前无活跃租约 → claim 之前先确认范围校验过了")
        return {"ok": True, "result": {"item": view, "etag": ctx.etag, "hint": "；".join(hint)}}

    def _do_item_claim(self, args, ctx):
        item_id = str(args.get("item_id") or (ctx.id if ctx else ""))
        res = self.client.claim(item_id, lease_seconds=args.get("lease_seconds"))
        if not res.ok:
            return self._handle_error(ctx, res)
        ctx.lease_token = str(res.data.get("lease_token") or "")
        ctx.lease_expires_at = str(res.data.get("lease_expires_at") or "")
        ctx.claim_attempted = True
        if res.etag:
            ctx.etag = res.etag          # 契约坑：重复 claim 会换发新 token，本地一律覆盖
        view = _item_view(res.item)
        if view.get("etag"):
            ctx.etag = view["etag"]
        ctx.to(KC.LEASED, "领取成功")
        return {"ok": True, "result": {
            "item": view,
            "etag": ctx.etag,
            "lease_expires_at": ctx.lease_expires_at,
            "note": "租约到手。写之前建议 item_read 预检一次；长活记得 item_heartbeat 续租",
        }}

    def _do_item_heartbeat(self, args, ctx):
        item_id = str(args.get("item_id") or (ctx.id if ctx else ""))
        if not ctx or not ctx.lease_token:
            return {"ok": False, "blocked": True, "error": "手上没租约，先 claim"}
        res = self.client.heartbeat(item_id, ctx.lease_token)
        if not res.ok:
            return self._handle_error(ctx, res)
        ctx.lease_expires_at = str(res.data.get("lease_expires_at") or ctx.lease_expires_at)
        return {"ok": True, "result": {"lease_expires_at": ctx.lease_expires_at}}

    def _do_item_release(self, args, ctx):
        item_id = str(args.get("item_id") or (ctx.id if ctx else ""))
        if not ctx or not ctx.lease_token:
            return {"ok": False, "blocked": True, "error": "手上没租约，没什么可释放的"}
        res = self.client.release(item_id, ctx.lease_token, args.get("reason") or "编排层主动释放")
        if not res.ok:
            return self._handle_error(ctx, res)
        ctx.lease_token = ""
        ctx.to(KC.ABANDONED, "主动释放")
        ctx.reset_scratch()
        return {"ok": True, "result": {"released": True, "item_id": item_id}}

    def _do_item_write_verdict(self, args, ctx):
        payload = {"state": args.get("state")}
        for src, dst in (("verdict_note", "verdict_note"), ("reason_code", "reason_code"),
                         ("confidence", "confidence"), ("reproduction_steps", "reproduction_steps"),
                         ("checks", "checks"), ("curl", "curl")):
            if args.get(src) is not None:
                payload[dst] = args[src]
        ids = args.get("evidence_ids") or []
        if ids:
            refs = []
            for eid in ids:
                ref = self._evidence_index.get(eid) if hasattr(self, "_evidence_index") else None
                refs.append(ref or {"id": eid})
            payload["evidence"] = refs

        status = str(args.get("state") or "")
        ctx.verdict_draft = payload
        ctx.to(KC.WRITING, "提交判定 " + status)
        res = self.client.patch_verdict(ctx.id, payload, ctx.etag, ctx.lease_token)
        if not res.ok:
            return self._handle_error(ctx, res)
        view = _item_view(res.item) or {}
        if res.etag:
            ctx.etag = res.etag
        if status in ("confirmed", "rejected"):
            ctx.lease_token = ""
            ctx.to(KC.SETTLED, "终态落库 " + status)
        else:
            ctx.to(KC.DECIDING, "非终态回写完成")
        return {"ok": True, "result": {
            "written": True,
            "state": status,
            "new_etag": ctx.etag,
            "review_status": res.data.get("item", {}).get("review_status") if isinstance(res.data.get("item"), dict) else None,
            "rubric_warnings": res.data.get("rubric_warnings") or [],
            "note": "写进去了；终态不能再原地改判，要推翻走 finding_report + supersedes",
        }}

    def _do_evidence_submit(self, args, ctx):
        text = str(args.get("content_text") or "")
        if not text:
            return {"ok": False, "error": "证据内容为空"}
        raw = text.encode("utf-8")
        digest = hashlib.sha256(raw).hexdigest()
        res = self.client.upload_evidence(
            base64.b64encode(raw).decode(), digest,
            args.get("kind") or "raw", args.get("note") or "")
        if not res.ok:
            return self._handle_error(ctx, res)
        ev = res.data.get("evidence") or res.data
        ev_id = str((ev or {}).get("id") or "")
        if not hasattr(self, "_evidence_index"):
            self._evidence_index = {}
        if ev_id:
            self._evidence_index[ev_id] = {"id": ev_id, "sha256": (ev or {}).get("sha256") or digest}
        return {"ok": True, "result": {
            "evidence_id": ev_id,
            "sha256": (ev or {}).get("sha256") or digest,
            "digest_verified": (ev or {}).get("digest_verified"),
            "note": "回写时把 evidence_id 放进 evidence_ids",
        }}

    def _do_rubric_lookup(self, args, ctx):
        kind = str(args.get("kind") or "")
        res = self.client.rubric(kind)
        if not res.ok:
            return self._handle_error(None, res)
        r = res.data.get("rubric") or res.data
        return {"ok": True, "result": {
            "rubric": r,
            "exact_match": res.data.get("exact_match"),
            "note": "exact_match=false 说明落到了 default 兜底准则",
        }}

    def _do_scope_check(self, args, ctx):
        urls = args.get("urls") or []
        if not urls:
            return {"ok": False, "error": "urls 不能为空"}
        res = self.client.scope_check(urls)
        hops = res.data.get("results") or []
        all_in = bool(res.ok and res.data.get("in_scope"))
        if ctx is not None:
            self.kc.on_scope_result(ctx, all_in, (hops[0] or {}).get("reason") if hops else "", hops)
        return {"ok": True, "result": {
            "in_scope": all_in,
            "hop_count": res.data.get("hop_count"),
            "hops": hops,
            "note": "逐跳都要在范围内；有一跳在外面，这条链路就别碰",
        }}

    def _do_contract_meta(self, args, ctx):
        res = self.client.contract_meta()
        if not res.ok:
            return self._handle_error(None, res)
        return {"ok": True, "result": res.data}

    def _do_finding_report(self, args, ctx):
        payload = {k: v for k, v in args.items() if v is not None}
        if not payload.get("kind") or not payload.get("endpoint"):
            return {"ok": False, "error": "kind 与 endpoint 必填"}
        idem = self._idem_key("report:" + (ctx.id if ctx else "-"), payload)
        res = self.client.report_finding(payload, idem)
        if not res.ok:
            return self._handle_error(ctx, res)
        return {"ok": True, "result": {
            "item": _item_view(res.item),
            "deduplicated": res.data.get("deduplicated"),
            "idempotency_key": idem,
            "rubric_warnings": res.data.get("rubric_warnings") or [],
        }}

    def _do_http_probe(self, args, ctx):
        if ctx is None or ctx.scope_ok is not True:
            return {"ok": False, "blocked": True, "error": "先 scope_check 通过再探测"}
        url = str(args.get("url") or "")
        method = str(args.get("method") or "GET").upper()
        if method not in ("GET", "HEAD"):
            return {"ok": False, "error": "只允许 GET / HEAD"}
        req = urllib.request.Request(url, method=method, headers={"User-Agent": "ReconLab-Console/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read(4096).decode("utf-8", "replace")
                return {"ok": True, "result": {"status": resp.status, "headers": dict(resp.getheaders()),
                                               "body_head": _clip(body, 800)}}
        except Exception as exc:
            return {"ok": True, "result": {"error": str(exc)[:200],
                                           "note": "探不通也可能是被 WAF/CDN 挡了，不代表漏洞不存在"}}

    def _do_finish(self, args, ctx):
        return {"ok": True, "finish": True, "result": {
            "summary": str(args.get("summary") or ""),
            "next": str(args.get("next") or ""),
        }}
