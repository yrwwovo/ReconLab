# -*- coding: utf-8 -*-
"""
编排层 · kill-chain 状态机 + 错误处置策略

这一层不是"流程图好看"，它只解决一件事：**把两边扯不清的那几条语义钉死成代码**，
让模型想乱来也乱不了。核心约束（全部对齐 openapi.yaml 与实测）：

  1. 读和租约彻底分开：拿最新版本用 GET（只读，不推 rev），干活前才 claim
  2. 412 只干一件事：拿响应头 ETag / data.current_etag 当新 If-Match 重试一次，再撞就弃单
     —— 412 分支里**不碰**租约/状态判断
  3. 409 才管租约与终态：LEASE_EXPIRED / NO_LEASE / ALREADY_CLAIMED / ALREADY_FINAL /
     SCOPE_EXPIRED，各自处置不同，且**弃单后不许本地重试 claim 同一条**
  4. ALREADY_SUPERSEDED 不是"重开"，是**换目标**：读 superseded_by → GET 新那条 →
     核实 state 与租约归属 → 活的才动，否则弃单
  5. 回写前必须先 GET 预检拿 etag；etag / lease_token 一律由本层注入，模型不碰
  6. 换目标 / 弃单时**清空上一条的判定草稿**，绝不把上下文串到下一条
"""

# ── 阶段 ──
IDLE = "IDLE"
QUEUED = "QUEUED"
PRECHECK = "PRECHECK"
LEASED = "LEASED"
PROBING = "PROBING"
DECIDING = "DECIDING"
WRITING = "WRITING"
SETTLED = "SETTLED"
ABANDONED = "ABANDONED"

STAGES = (IDLE, QUEUED, PRECHECK, LEASED, PROBING, DECIDING, WRITING, SETTLED, ABANDONED)

ALLOWED_TRANSITIONS = {
    IDLE: {QUEUED},
    QUEUED: {PRECHECK, LEASED, ABANDONED},   # claim 是写操作，允许不先读就直接领
    PRECHECK: {LEASED, ABANDONED, QUEUED},
    LEASED: {PROBING, DECIDING, WRITING, ABANDONED},
    PROBING: {DECIDING, LEASED, ABANDONED},
    DECIDING: {WRITING, PROBING, ABANDONED},
    WRITING: {SETTLED, DECIDING, ABANDONED},   # 判定准则不过 → 回炉重判
    SETTLED: set(),
    ABANDONED: set(),
}

TERMINAL = {SETTLED, ABANDONED}

# 工具 → 允许的阶段
TOOL_STAGE_GATE = {
    "queue_overview": set(STAGES),
    "item_read": {QUEUED, PRECHECK, LEASED, PROBING, DECIDING, WRITING},
    "item_claim": {QUEUED, PRECHECK},
    "item_heartbeat": {LEASED, PROBING, DECIDING, WRITING},
    "item_release": {LEASED, PROBING, DECIDING, WRITING},
    "item_write_verdict": {DECIDING, WRITING, LEASED},
    "rubric_lookup": set(STAGES),
    "scope_check": set(STAGES),
    "evidence_submit": {LEASED, PROBING, DECIDING, WRITING},
    "finding_report": set(STAGES),
    "http_probe": {LEASED, PROBING},
    "contract_meta": set(STAGES),
    "finish": set(STAGES),          # 收尾工具，任何阶段都能调
}


class Action(object):
    """错误处置结论。model 看得到 hint，用来决定下一步怎么走。"""

    def __init__(self, kind, reason, hint="", wait=0):
        self.kind = kind          # retry_new_etag / follow_supersede / re_decide / retry / abandon / blocked / fatal
        self.reason = reason
        self.hint = hint
        self.wait = wait

    def as_dict(self):
        d = {"action": self.kind, "reason": self.reason}
        if self.hint:
            d["hint"] = self.hint
        if self.wait:
            d["retry_after"] = self.wait
        return d


class ItemContext(object):
    """单条记录干活的上下文。换目标或弃单时整个丢掉，绝不复用。"""

    def __init__(self, item_id, stage=QUEUED):
        self.id = item_id
        self.stage = stage
        self.etag = ""
        self.lease_token = ""
        self.lease_expires_at = ""
        self.superseded_by = ""
        self.scope_ok = None
        self.scope_reason = ""
        self.scope_hops = []
        self.etag_retries = 0
        self.rubric_retries = 0
        self.transport_retries = 0
        self.heartbeat_at = 0.0
        self.claim_attempted = False
        self.findings = []          # 观察到的点（模型自己的记录，短文本）
        self.verdict_draft = None
        self.abandon_reason = ""
        self.history = []           # 阶段迁移轨迹，给界面看

    # ── 状态迁移 ──

    def to(self, stage, note=""):
        if stage == self.stage:
            return True
        if stage not in ALLOWED_TRANSITIONS.get(self.stage, set()):
            return False
        self.history.append({"from": self.stage, "to": stage, "note": note})
        self.stage = stage
        return True

    def reset_scratch(self):
        """清判定草稿与观察记录 —— 换目标/弃单必调，防串数据。"""
        self.findings = []
        self.verdict_draft = None
        self.scope_ok = None
        self.scope_reason = ""
        self.scope_hops = []
        self.etag_retries = 0
        self.rubric_retries = 0
        self.transport_retries = 0

    def snapshot(self):
        return {
            "item_id": self.id,
            "stage": self.stage,
            "etag": self.etag,
            "has_lease": bool(self.lease_token),
            "lease_expires_at": self.lease_expires_at,
            "scope_ok": self.scope_ok,
            "scope_reason": self.scope_reason,
            "etag_retries": self.etag_retries,
            "rubric_retries": self.rubric_retries,
            "superseded_by": self.superseded_by,
            "abandon_reason": self.abandon_reason,
            "history": self.history[-8:],
        }


class KillChain(object):
    """一个会话里所有记录的 kill-chain 台账。"""

    def __init__(self, max_etag_retry=1, max_rubric_retry=2, max_transport_retry=2):
        self.items = {}
        self.active_id = None
        self.max_etag_retry = max_etag_retry
        self.max_rubric_retry = max_rubric_retry
        self.max_transport_retry = max_transport_retry
        self.audit = []          # 给人看的处置流水

    # ── 台账 ──

    def item(self, item_id):
        ctx = self.items.get(item_id)
        if ctx is None:
            ctx = ItemContext(item_id)
            self.items[item_id] = ctx
        return ctx

    @property
    def active(self):
        return self.items.get(self.active_id) if self.active_id else None

    def focus(self, item_id, stage=QUEUED):
        """把工作焦点切到某条记录。切之前把旧的那条草稿清掉（不串数据）。"""
        if self.active_id and self.active_id != item_id:
            prev = self.items.get(self.active_id)
            if prev is not None and prev.stage not in TERMINAL:
                prev.reset_scratch()
                prev.to(ABANDONED, "被新目标顶替，草稿作废")
        ctx = self.item(item_id)
        if ctx.stage == IDLE:
            ctx.to(QUEUED, "聚焦")
        elif stage != ctx.stage and stage in ALLOWED_TRANSITIONS.get(ctx.stage, set()):
            ctx.to(stage, "聚焦")
        self.active_id = item_id
        return ctx

    def log(self, kind, detail):
        self.audit.append({"kind": kind, "detail": detail})

    # ── 阶段守卫 ──

    def gate(self, tool, ctx):
        """工具能不能在当下阶段调。返回 (ok, 提示)。"""
        allowed = TOOL_STAGE_GATE.get(tool)
        if allowed is None:
            return False, "未知工具 %s" % tool
        if ctx is None:
            if tool in ("queue_overview", "rubric_lookup", "scope_check", "contract_meta", "finding_report"):
                return True, ""
            return False, "还没有聚焦的记录：先 queue_overview 挑一条，再 item_read"
        if ctx.stage not in allowed:
            return False, ("当前阶段 %s 不能调 %s（允许的阶段：%s）"
                           % (ctx.stage, tool, "/".join(sorted(allowed))))
        if tool == "item_write_verdict":
            if not ctx.lease_token:
                return False, "没有租约：先 item_claim 领取，再回写判定"
            if not ctx.etag:
                return False, "手上没有 etag：先 item_read 预检拿最新版本"
            if ctx.scope_ok is not True:
                return False, "还没过授权范围校验：先对目标跑 scope_check"
        if tool == "http_probe" and ctx.scope_ok is not True:
            return False, "主动探测前必须先 scope_check 通过"
        return True, ""

    def on_scope_result(self, ctx, in_scope, reason, hops):
        if ctx is None:
            return
        ctx.scope_ok = bool(in_scope)
        ctx.scope_reason = reason or ""
        ctx.scope_hops = hops or []
        if in_scope and ctx.stage == QUEUED:
            ctx.to(PRECHECK, "范围校验通过")

    # ── 错误处置（核心） ──

    def decide_on_error(self, ctx, result):
        """把一次失败的契约调用翻译成明确的处置动作。"""
        transport = result.transport_error
        if transport:
            if ctx and ctx.transport_retries < self.max_transport_retry:
                ctx.transport_retries += 1
                self.log("transport_retry", "%s 第 %d 次" % (ctx.id, ctx.transport_retries))
                return Action("retry", "后端连不上：%s" % transport,
                              "网络/后端问题，稍后原样重试；连续失败就停下报给人")
            return Action("abandon", "后端连不上：%s" % transport, "交给操作员处理")

        status, code = result.status, result.code
        data = result.data.get("data") or {}

        # 鉴权 / 契约版本：配置问题，不重试
        if status == 401 or code in ("AGENT_KEY_INVALID", "AGENT_DISABLED", "UNAUTHORIZED"):
            return Action("fatal", "Agent Key 无效或权限不足",
                          "这是配置问题：控制台「Agent 接入」重新生成 key（要 review 权限）填进 .env")
        if code == "CONTRACT_VERSION_UNSUPPORTED":
            return Action("fatal", "契约版本不被支持", "两边契约版本不一致，先对齐 openapi.yaml")
        if status == 403 or code == "OUT_OF_SCOPE":
            if ctx:
                ctx.scope_ok = False
                ctx.scope_reason = code or "OUT_OF_SCOPE"
                ctx.abandon_reason = "目标不在授权范围内"
                ctx.reset_scratch()
                ctx.to(ABANDONED, "范围外")
            return Action("abandon", "目标不在授权范围内",
                          "契约硬边界：范围外的记录领不走也写不进，换一条记录，别试图绕过")
        if status == 404:
            if ctx:
                ctx.abandon_reason = "记录不存在"
                ctx.reset_scratch()
                ctx.to(ABANDONED, "记录不存在")
            return Action("abandon", "记录不存在", "换一条记录重来")

        # 409 家族：租约 / 终态 / 范围失效 / 已取代 —— 各自不同
        if status == 409:
            if code == "ALREADY_SUPERSEDED":
                new_id = str(data.get("superseded_by") or "")
                if ctx:
                    ctx.superseded_by = new_id
                self.log("follow_supersede", "%s → %s" % (ctx.id if ctx else "?", new_id or "?"))
                return Action("follow_supersede", "这条已被新记录取代",
                              "正确姿势不是「重开」：去 superseded_by 指向的那条（%s），"
                              "先 GET 看 state 和租约归属，活的才动，否则弃单" % (new_id or "?"))
            if code in ("LEASE_EXPIRED", "NO_LEASE"):
                if ctx:
                    ctx.lease_token = ""
                    # 契约坑：重复 claim 会换发新 token，旧 token 当场作废 —— 这里不本地重试 claim 同一条
                    ctx.abandon_reason = "租约失效（%s）" % code
                    ctx.reset_scratch()
                    ctx.to(ABANDONED, "租约失效")
                return Action("abandon", "租约失效：%s" % code,
                              "租约没了就别硬写：**不许本地重试 claim 同一条**，"
                              "换下一条记录，或先 release 再重新走一遍领取")
            if code == "ALREADY_CLAIMED":
                if ctx:
                    ctx.abandon_reason = "已被别人领走"
                    ctx.reset_scratch()
                    ctx.to(ABANDONED, "他人持有租约")
                return Action("abandon", "这条正被别的 worker 领着",
                              "换一条；想等就等租约超时（服务端惰性回收），别抢")
            if code in ("ALREADY_FINAL", "TERMINAL_IMMUTABLE", "INVALID_STATE_TRANSITION"):
                if ctx:
                    ctx.abandon_reason = "终态不可原地回退"
                    ctx.reset_scratch()
                    ctx.to(ABANDONED, "终态")
                return Action("abandon", "终态记录不能原地改判",
                              "要推翻已签字结论：POST 一条带 supersedes=<这条 id> 的新记录，"
                              "别原地改历史；走 finding_report 工具")
            if code == "SCOPE_EXPIRED":
                if ctx:
                    ctx.scope_ok = False
                    ctx.abandon_reason = "授权范围已失效"
                    ctx.reset_scratch()
                    ctx.to(ABANDONED, "范围失效")
                return Action("abandon", "任务作废：授权范围中途失效",
                              "这是硬作废，重试也没用；让操作员续期范围后再开新记录")
            if code == "IDEMPOTENCY_CONFLICT":
                return Action("re_decide", "幂等键冲突",
                              "幂等键换了含义：同 key 必须同内容；重新上报时换个新的 key")
            return Action("abandon", "冲突未分类：%s" % (code or "409"),
                          "记下来交给人看，别猜着硬写")

        # 412：只做一件事 —— 换新 etag 重试一次
        if status == 412 or code == "PRECONDITION_FAILED":
            fresh = str(data.get("current_etag") or result.etag or "")
            if ctx and fresh and ctx.etag_retries < self.max_etag_retry:
                ctx.etag_retries += 1
                ctx.etag = fresh
                ctx.to(DECIDING, "412 → 换新 etag 重试")
                self.log("etag_refresh", "%s → %s" % (ctx.id, fresh))
                return Action("retry_new_etag", "内容版本对不上（412）",
                              "已用服务端给的 current_etag=%s 覆盖本地 etag，直接重试提交；"
                              "别再 GET 一次（响应里已经给了）" % fresh)
            if ctx:
                ctx.abandon_reason = "412 重试后仍冲突"
                ctx.reset_scratch()
                ctx.to(ABANDONED, "412 反复")
            return Action("abandon", "412 反复冲突",
                          "有人一直在改这条记录：弃单回队列，别循环重试（412 里不涉及租约判断）")

        if status == 428 or code == "PRECONDITION_REQUIRED":
            fresh = str(data.get("current_etag") or "")
            if ctx:
                ctx.etag = fresh or ctx.etag
                ctx.to(DECIDING, "428 → 补 If-Match 重试")
            return Action("retry_new_etag", "缺 If-Match（428）",
                          "已补上 current_etag 重试；回写的 If-Match 由编排层注入，你不用管")

        # 422：判定准则 / 字段不合法 —— 回炉重判，不是网络问题
        if status == 422:
            if code == "RUBRIC_VIOLATION":
                errs = data.get("errors") or []
                if ctx and ctx.rubric_retries < self.max_rubric_retry:
                    ctx.rubric_retries += 1
                    ctx.to(DECIDING, "准则不过 → 回炉")
                    return Action("re_decide", "不满足判定准则",
                                  "服务端退回的原因：%s；补齐证据/复核项或改判，别硬凑"
                                  % (errs[0].get("message") if errs else "见 data.errors"))
                if ctx:
                    ctx.abandon_reason = "准则反复不过"
                    ctx.reset_scratch()
                    ctx.to(ABANDONED, "准则不过")
                return Action("abandon", "判定准则反复不过",
                              "这条按当前判据交不出来：退回队列交给人看，别编证据")
            if ctx and ctx.rubric_retries < self.max_rubric_retry:
                ctx.rubric_retries += 1
                ctx.to(DECIDING, "422 → 回炉")
                return Action("re_decide", "字段不合法：%s" % (code or 422),
                              "按服务端校验错误改参数重来")
            if ctx:
                ctx.abandon_reason = "字段反复不合法"
                ctx.reset_scratch()
                ctx.to(ABANDONED, "字段不合法")
            return Action("abandon", "字段反复不合法", "弃单，别耗在一条上")

        # 429：退避重试
        if status == 429 or code == "RATE_LIMITED":
            wait = 0
            try:
                wait = int(result.headers.get("retry-after") or (data.get("retry_after") or 5))
            except (TypeError, ValueError):
                wait = 5
            return Action("retry", "被限流", "按 Retry-After 退避后再打", wait=min(wait, 30))

        if 200 <= status < 300:
            return Action("none", "")

        return Action("abandon", "未分类失败：%s %s" % (status, code or ""),
                      "别猜，记下来交给人看")
