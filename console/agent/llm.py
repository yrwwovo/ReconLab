# -*- coding: utf-8 -*-
"""
编排层 · 模型客户端（OpenAI 兼容：/chat/completions）

两个必须守住的细节（踩过就白跑）：

  1. 带 tools 的请求，历史轮次里 assistant 的消息必须**整条回传**
     —— 只取 content 丢掉 reasoning_content / tool_calls，下一轮直接 400。
     所以这里一律 append 原始的 message 对象，不自己拼 dict。
  2. 缓存前缀：system 消息（契约摘要 + 工具策略 + 状态机规则）必须逐字节稳定，
     变量内容一律往后放。命中缓存 vs 未命中，价格差一个数量级。
"""

import json
import time
import urllib.error
import urllib.request


class LLMError(Exception):
    def __init__(self, message, status=0, body=None):
        Exception.__init__(self, message)
        self.status = status
        self.body = body or {}


class AssistantTurn(object):
    """一轮模型输出。raw_message 原样保存，下一轮整条回传。"""

    __slots__ = ("content", "reasoning_content", "tool_calls", "raw_message", "usage", "model", "ms")

    def __init__(self, message, usage, model, ms):
        self.raw_message = message if isinstance(message, dict) else {"role": "assistant", "content": ""}
        self.content = self.raw_message.get("content") or ""
        self.reasoning_content = self.raw_message.get("reasoning_content") or ""
        self.tool_calls = self.raw_message.get("tool_calls") or []
        self.usage = usage or {}
        self.model = model or ""
        self.ms = ms

    def as_message(self):
        """回传给 API 的形态：整条，别裁。"""
        msg = {"role": "assistant"}
        if self.content:
            msg["content"] = self.content
        else:
            msg["content"] = ""
        if self.reasoning_content:
            msg["reasoning_content"] = self.reasoning_content
        if self.tool_calls:
            msg["tool_calls"] = self.tool_calls
        return msg


class LLMClient(object):
    def __init__(self, cfg):
        self.cfg = cfg

    # ── 底座 ──

    def _post(self, payload, timeout=None):
        url = self.cfg.llm_base_url + "/chat/completions"
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(url, data=body, method="POST", headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + self.cfg.llm_api_key,
            "Accept": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.cfg.llm_timeout) as resp:
                return json.loads(resp.read().decode("utf-8", "replace") or "{}")
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", "replace")
            try:
                parsed = json.loads(raw)
            except ValueError:
                parsed = {"_raw": raw[:400]}
            raise LLMError("模型接口返回 %s" % exc.code, exc.code, parsed)
        except Exception as exc:
            raise LLMError("模型接口连不上：%s" % exc, 0, {})

    def chat(self, messages, tools=None, model=None, tool_choice=None,
             response_format=None, temperature=None, max_tokens=None):
        """一次不带重试的调用（重试在 call() 里统一做）。"""
        payload = {
            "model": model or self.cfg.llm_model,
            "messages": messages,
            "max_tokens": max_tokens or self.cfg.llm_max_tokens,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = tool_choice or "auto"
        if response_format:
            payload["response_format"] = response_format
        if temperature is not None:
            payload["temperature"] = temperature
        # 思考模式：默认关（Agent 循环里每步都思考，又贵又慢；规划阶段再开）
        think = str(self.cfg.llm_thinking or "").lower()
        if think and think != "auto":
            if think == "disabled":
                payload["thinking"] = {"type": "disabled"}
            else:
                payload["thinking"] = {"type": "enabled", "effort": think}

        extra = self.cfg.env_source.get("CONSOLE_LLM_EXTRA_JSON")
        if extra:
            try:
                payload.update(json.loads(extra))
            except ValueError:
                pass

        started = time.time()
        data = self._post(payload)
        choices = data.get("choices") or []
        message = (choices[0].get("message") if choices else {}) or {}
        return AssistantTurn(message, data.get("usage"), data.get("model"),
                             int((time.time() - started) * 1000))

    def call(self, messages, **kw):
        """带退避重试的调用：只重试 429 / 5xx / 网络错误；4xx 直接抛。"""
        last = None
        for attempt in range(max(1, self.cfg.llm_retries)):
            try:
                return self.chat(messages, **kw)
            except LLMError as exc:
                last = exc
                retryable = exc.status in (0, 408, 409, 429, 500, 502, 503, 504)
                if not retryable or attempt == self.cfg.llm_retries - 1:
                    raise
                time.sleep(min(2 ** attempt, 8))
        raise last

    # ── 结构化输出（strict json_schema） ──

    def structured(self, messages, name, schema, model=None, strict=None):
        """要一个严格符合 schema 的 JSON 对象回来。失败会抛 LLMError。"""
        strict = self.cfg.llm_strict if strict is None else strict
        rf = {
            "type": "json_schema",
            "json_schema": {"name": name, "schema": schema, "strict": bool(strict)},
        }
        turn = self.call(messages, model=model, response_format=rf)
        text = (turn.content or "").strip()
        if text.startswith("```"):
            text = text.strip("`")
            text = text.split("\n", 1)[1] if "\n" in text else text
        try:
            return json.loads(text), turn
        except ValueError:
            raise LLMError("模型没按 JSON 出参：%s" % text[:200], 0, {"raw": text[:500]})
