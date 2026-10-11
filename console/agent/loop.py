# -*- coding: utf-8 -*-
"""
编排层 · Plan-Execute 主循环

一轮对话 = 一次 run_turn：
  1) PLAN    —— 先出计划（strict JSON），把意图/假设/步骤/收手条件摆明
  2) EXECUTE —— 循环调工具，每一步的结果都回喂；状态机在中间拦非法动作
  3) REPORT  —— 收尾：做完什么、还剩什么、下一条建议动谁

设计要点：
  · system 消息（冻结前缀）永远在第 0 位，且逐字节不变 → 吃缓存
  · assistant 消息**整条**回传（含 reasoning_content / tool_calls），否则带 tools 的下一轮会 400
  · 工具结果压扁成 role=tool 的消息回喂，长内容截断，别把上下文撑爆
  · 每轮都有硬预算：max_steps 步 + 每步一次模型调用，超了就停手汇报，绝不空转
"""

import json
import threading
import time
import traceback

from . import killchain as KC
from . import prompts
from .llm import LLMClient, LLMError
from .reconlab import ReconLabClient
from .tools import ToolRunner, strictify, tool_defs


class Orchestrator(object):
    def __init__(self, cfg, store):
        self.cfg = cfg
        self.store = store
        self.client = ReconLabClient(cfg)
        self._llm = LLMClient(cfg)
        self._cancels = {}
        self._threads = {}
        self._tools_cache = None

    def llm(self):
        return self._llm

    # ── 对外 ──

    def tools(self):
        if self._tools_cache is None:
            defs = tool_defs(self.cfg)
            out = []
            for t in defs:
                if self.cfg.llm_strict and t["function"]["name"] == "item_write_verdict":
                    t = strictify(t)
                out.append(t)
            out = [t for t in out if t["function"]["name"] not in self._disabled()]
            self._tools_cache = out
        return self._tools_cache

    def _disabled(self):
        off = set()
        if not self.cfg.allow_active_probe:
            off.add("http_probe")
        return off

    def is_running(self, sid):
        th = self._threads.get(sid)
        return bool(th and th.is_alive())

    def cancel(self, sid):
        self._cancels[sid] = True

    def start_turn(self, sid, user_text):
        """起一个后台线程跑这一轮（HTTP 请求立刻返回，前端看事件流）。"""
        if self.is_running(sid):
            return False
        self._cancels[sid] = False
        th = threading.Thread(target=self.run_turn, args=(sid, user_text), daemon=True)
        self._threads[sid] = th
        th.start()
        return True

    # ── 事件 ──

    def _emit(self, sid, kind, payload):
        return self.store.add_event(sid, kind, payload)

    # ── 主循环 ──

    def run_turn(self, sid, user_text):
        session = self.store.get_session(sid)
        if session is None:
            return
        self.store.add_message(sid, "user", user_text)
        self.store.set_status(sid, "planning")
        self._emit(sid, "status", {"status": "planning", "text": "在出计划…"})

        kc = KillChain_from_meta(session.get("meta") or {} , self.cfg)
        runner = ToolRunner(self.cfg, self.client, kc, lambda k, p: self._emit(sid, k, p))

        try:
            preamble = self._preamble(session, kc)
            plan, plan_turn = self._plan(sid, user_text, preamble)
            self._emit(sid, "plan", plan)

            self.store.set_status(sid, "running")
            self._emit(sid, "status", {"status": "running", "text": "开始执行…"})

            messages = list(self._conversation_head(user_text, preamble, plan))
            summary = self._execute(sid, messages, runner, kc, plan)

            self.store.add_message(sid, "assistant", summary)
            self.store.set_status(sid, "done", meta=self._meta_out(kc, summary))
            self._emit(sid, "done", {"summary": summary, "killchain": self._kc_view(kc)})
        except LLMError as exc:
            self.store.set_status(sid, "error")
            self._emit(sid, "error", {"where": "llm", "message": str(exc), "status": exc.status})
            self.store.add_message(sid, "assistant", "这一轮没跑完：模型接口报错 %s" % exc)
        except Exception as exc:                       # 兜底：别让线程带着异常静默消失
            self.store.set_status(sid, "error")
            self._emit(sid, "error", {"where": "orchestrator", "message": str(exc),
                                      "trace": traceback.format_exc()[-1200:]})
            self.store.add_message(sid, "assistant", "这一轮没跑完：%s" % exc)

    # ── 计划阶段 ──

    def _plan(self, sid, user_text, preamble):
        msgs = prompts.plan_messages(self.cfg, user_text, preamble)
        try:
            plan, turn = self.llm().structured(msgs, "reconlab_plan", prompts.PLAN_SCHEMA,
                                               model=self.cfg.llm_plan_model)
            plan["_usage"] = turn.usage
            plan["_degraded"] = False
            return plan, turn
        except LLMError as exc:
            self._emit(sid, "plan_fallback", {"reason": str(exc)[:300]})
            return ({
                "intent": "直接干活（规划失败，降级为单步执行）",
                "hypothesis": "模型没按 schema 出计划，退化成边看边做",
                "steps": [{"id": "s1", "goal": "看队列挑一条能干的", "tool": "queue_overview",
                           "done_when": "拿到待验证记录或确认队列空"}],
                "stop_when": "拿到结论或连续两次被拦",
                "_degraded": True,
                "_error": str(exc)[:300],
            }, None)

    # ── 执行阶段 ──

    def _execute(self, sid, messages, runner, kc, plan):
        tools = self.tools()
        last_text = ""
        finish_payload = None

        for step in range(self.cfg.max_steps):
            if self._cancels.get(sid):
                self._emit(sid, "status", {"status": "canceled", "text": "操作员叫停"})
                break

            self._emit(sid, "step", {"index": step + 1, "of": self.cfg.max_steps})
            try:
                turn = self.llm().call(messages, tools=tools, model=self.cfg.llm_fast_model)
            except LLMError as exc:
                # 工具调用被拒 / 参数不合法这类，回收成一次纠正机会
                self._emit(sid, "error", {"where": "llm-step", "message": str(exc)[:400],
                                          "status": exc.status})
                break

            self._emit(sid, "usage", {"step": step + 1, "usage": turn.usage, "ms": turn.ms})
            messages.append(turn.as_message())

            if turn.content:
                last_text = turn.content
                self._emit(sid, "assistant", {"text": turn.content})
                self.store.add_message(sid, "assistant_chunk", turn.content)

            if not turn.tool_calls:
                if turn.content:
                    break
                messages.append({"role": "user", "content": "继续：要么调工具，要么 finish 收尾。"})
                continue

            for call in turn.tool_calls:
                fn = (call.get("function") or {})
                name = fn.get("name") or ""
                raw_args = fn.get("arguments") or "{}"
                try:
                    args = json.loads(raw_args) if isinstance(raw_args, str) else (raw_args or {})
                except ValueError:
                    args = {}
                    out = {"ok": False, "error": "参数不是合法 JSON：%s" % raw_args[:200]}
                    messages.append({"role": "tool", "tool_call_id": call.get("id"),
                                     "content": json.dumps(out, ensure_ascii=False)})
                    continue

                self._emit(sid, "tool_call", {"id": call.get("id"), "tool": name, "args": args})
                out = runner.run(name, args)
                self._emit(sid, "tool_result", {"id": call.get("id"), "tool": name, "outcome": out})
                if kc.active is not None:
                    self._emit(sid, "item_state", kc.active.snapshot())

                messages.append({
                    "role": "tool",
                    "tool_call_id": call.get("id"),
                    # 整个 outcome 回喂（含 ok / blocked / action / result）——
                    # 模型要靠 action 才知道该换目标还是弃单
                    "content": json.dumps(out, ensure_ascii=False)[:6000],
                })

                if out.get("finish"):
                    finish_payload = out.get("result") or {}
                    break
                if out.get("action") == "fatal":
                    self._emit(sid, "status", {"status": "fatal",
                                               "text": (out.get("result") or {}).get("action", {}).get("reason", "")})
                    return self._final_text(kc, last_text, "配置/契约层面的硬错误，已停手")

            if finish_payload is not None:
                break

            # 每 6 步提醒一次预算，别让模型无限刷工具
            if step and step % 6 == 0:
                messages.append({"role": "user",
                                 "content": "预算提醒：已用 %d/%d 步。没必要的工具别调，该收尾就 finish。"
                                            % (step + 1, self.cfg.max_steps)})
        else:
            self._emit(sid, "status", {"status": "budget", "text": "到步数上限，停手汇报"})

        return self._final_text(kc, last_text, finish_payload)

    def _final_text(self, kc, last_text, finish_payload):
        if finish_payload:
            return "本轮收尾：%s%s" % (finish_payload.get("summary", ""),
                                       ("\n下一步：" + finish_payload["next"]) if finish_payload.get("next") else "")
        if last_text:
            return last_text
        parts = []
        for ctx in kc.items.values():
            parts.append("%s → %s%s" % (ctx.id, ctx.stage,
                                        ("（%s）" % ctx.abandon_reason) if ctx.abandon_reason else ""))
        return "本轮结束，没有额外说明。记录状态：" + ("；".join(parts) if parts else "未动任何记录")

    # ── 上下文组装 ──

    def _conversation_head(self, user_text, preamble, plan):
        head = [
            {"role": "system", "content": prompts.frozen_prefix(self.cfg)},
            {"role": "user", "content": "## 这一轮的现场\n%s\n\n## 操作员的要求\n%s" % (preamble, user_text)},
            {"role": "assistant", "content": "计划：\n" + json.dumps(
                {k: v for k, v in plan.items() if not k.startswith("_")}, ensure_ascii=False, indent=2)},
            {"role": "user", "content": "按计划开干。每一步都用工具拿到事实再下结论，"
                                        "该收尾时调 finish。"},
        ]
        return head

    def _preamble(self, session, kc):
        bits = []
        bits.append("会话：%s" % session.get("id"))
        meta = session.get("meta") or {}
        if meta.get("last_summary"):
            bits.append("上一轮结论：%s" % str(meta["last_summary"])[:400])
        if kc.items:
            live = [c.snapshot() for c in kc.items.values() if c.stage not in KC.TERMINAL]
            if live:
                bits.append("手上没结完的记录：%s" % json.dumps(live, ensure_ascii=False)[:900])
        bits.append("注意：队列状态别凭记忆，用 queue_overview 现看一眼。")
        return "\n".join(bits)

    # ── 会话元信息 ──

    def _meta_out(self, kc, summary=""):
        return {"killchain": self._kc_view(kc), "last_summary": summary}

    def _kc_view(self, kc):
        return {i: c.snapshot() for i, c in kc.items.items()}


# ───────────────────────── 从元信息恢复状态机 ─────────────────────────

def KillChain_from_meta(meta, cfg):
    """只恢复"还在手上没结完"的记录骨架。

    注意：**不恢复 lease_token** —— 租约可能早过期了，拿旧 token 去写必然 409 LEASE_EXPIRED。
    新一轮开工要重新 claim（claim 会换发新 token，编排层自动覆盖）。
    """
    kc = KC.KillChain(max_etag_retry=cfg.max_412_retry, max_rubric_retry=cfg.max_rubric_retry)
    snapshot = (meta or {}).get("killchain") or {}
    for item_id, snap in snapshot.items():
        if not isinstance(snap, dict):
            continue
        if snap.get("stage") in KC.TERMINAL:
            continue
        ctx = KC.ItemContext(item_id, stage=KC.QUEUED)
        ctx.etag = str(snap.get("etag") or "")
        ctx.scope_ok = snap.get("scope_ok")
        kc.items[item_id] = ctx
    return kc
