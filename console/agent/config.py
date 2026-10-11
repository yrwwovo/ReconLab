# -*- coding: utf-8 -*-
"""
对话式作战台 · 配置

所有可调项都从环境变量或本目录下的 .env 读。**密钥只从环境来**，
代码里不写死任何 key —— 你填 .env 就行。

.env 查找顺序：
  1) 环境变量（最高优先级）
  2) console/.env
  3) 仓库根目录 .env
"""

import os
import re

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)


def _parse_env_file(path):
    out = {}
    if not os.path.isfile(path):
        return out
    with open(path, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[7:].strip()
            if "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            out[k] = v
    return out


def load_env():
    """环境变量优先；文件只补空缺。返回合并后的字典。"""
    merged = {}
    for path in (os.path.join(_ROOT, ".env"), os.path.join(_HERE, ".env")):
        merged.update(_parse_env_file(path))
    for k, v in os.environ.items():
        merged[k] = v
    return merged


def _b(env, key, default=False):
    v = str(env.get(key, "")).strip().lower()
    if not v:
        return default
    return v in ("1", "true", "yes", "on", "y")


def _i(env, key, default):
    try:
        return int(str(env.get(key, "")).strip())
    except (TypeError, ValueError):
        return default


PLACEHOLDER_PATTERN = re.compile(r"^(|your[-_ ].*|xxx+|sk-xxx.*|changeme|placeholder|TODO)$", re.I)


class Config(object):
    """一次性把配置摊平，跑起来之后不再变（改配置就重启）。"""

    def __init__(self, env=None):
        env = env if env is not None else load_env()
        self.env_source = env

        # ── 模型侧 ──
        self.llm_provider = str(env.get("CONSOLE_LLM_PROVIDER", "deepseek")).strip()
        self.llm_base_url = str(env.get("CONSOLE_LLM_BASE_URL", "https://api.deepseek.com/v1")).rstrip("/")
        self.llm_api_key = str(env.get("CONSOLE_LLM_API_KEY", "")).strip()
        self.llm_model = str(env.get("CONSOLE_LLM_MODEL", "deepseek-chat")).strip()
        # 规划/冲突消解用强模型，执行/判定用便宜档（留空 = 都用主模型）
        self.llm_plan_model = str(env.get("CONSOLE_LLM_PLAN_MODEL", "")).strip() or self.llm_model
        self.llm_fast_model = str(env.get("CONSOLE_LLM_FAST_MODEL", "")).strip() or self.llm_model
        # 思考模式：high / medium / low / disabled。默认关——Agent 循环里每步都思考又贵又慢
        self.llm_thinking = str(env.get("CONSOLE_LLM_THINKING", "disabled")).strip().lower()
        self.llm_max_tokens = _i(env, "CONSOLE_LLM_MAX_TOKENS", 4096)
        self.llm_timeout = _i(env, "CONSOLE_LLM_TIMEOUT", 180)
        self.llm_retries = _i(env, "CONSOLE_LLM_RETRIES", 3)
        self.llm_strict = _b(env, "CONSOLE_LLM_STRICT", True)   # 回写用 strict json_schema

        # ── 后端契约侧 ──
        self.reconlab_base_url = str(env.get("RECONLAB_BASE_URL", "http://127.0.0.1:8090")).rstrip("/")
        self.reconlab_api_key = str(env.get("RECONLAB_WORKER_KEY", "")).strip()
        self.worker_id = str(env.get("RECONLAB_WORKER_ID", "console-01")).strip()
        self.lease_seconds = _i(env, "RECONLAB_LEASE_SECONDS", 900)
        self.timeout = _i(env, "RECONLAB_TIMEOUT", 30)

        # ── 编排策略 ──
        self.max_steps = _i(env, "CONSOLE_MAX_STEPS", 24)       # 一轮最多多少个工具步
        self.max_rubric_retry = _i(env, "CONSOLE_MAX_RUBRIC_RETRY", 2)
        self.max_412_retry = _i(env, "CONSOLE_MAX_412_RETRY", 1)  # 契约：412 只重试一次
        self.allow_active_probe = _b(env, "CONSOLE_ALLOW_ACTIVE_PROBE", False)

        # ── 服务侧 ──
        self.host = str(env.get("CONSOLE_HOST", "127.0.0.1")).strip()
        self.port = _i(env, "CONSOLE_PORT", 8091)
        self.db_path = str(env.get("CONSOLE_DB", os.path.join(_HERE, "console.sqlite"))).strip()

    # ── 状态自述（给 /health 和界面顶部横幅用，绝不回显 key 本身） ──

    def _looks_placeholder(self, value):
        return bool(PLACEHOLDER_PATTERN.match(str(value).strip()))

    @property
    def llm_configured(self):
        return bool(self.llm_api_key) and not self._looks_placeholder(self.llm_api_key)

    @property
    def reconlab_configured(self):
        return bool(self.reconlab_api_key) and not self._looks_placeholder(self.reconlab_api_key)

    def health(self):
        return {
            "llm": {
                "provider": self.llm_provider,
                "base_url": self.llm_base_url,
                "model": self.llm_model,
                "plan_model": self.llm_plan_model,
                "fast_model": self.llm_fast_model,
                "thinking": self.llm_thinking,
                "strict_writeback": self.llm_strict,
                "key_configured": self.llm_configured,
                "key_hint": (self.llm_api_key[:6] + "…" + self.llm_api_key[-4:]) if len(self.llm_api_key) >= 12 else "",
            },
            "reconlab": {
                "base_url": self.reconlab_base_url,
                "worker_id": self.worker_id,
                "lease_seconds": self.lease_seconds,
                "key_configured": self.reconlab_configured,
            },
            "policy": {
                "max_steps": self.max_steps,
                "max_412_retry": self.max_412_retry,
                "max_rubric_retry": self.max_rubric_retry,
                "allow_active_probe": self.allow_active_probe,
            },
            "ready": self.llm_configured and self.reconlab_configured,
        }

    def missing(self):
        miss = []
        if not self.llm_configured:
            miss.append("CONSOLE_LLM_API_KEY（模型 Key）")
        if not self.reconlab_configured:
            miss.append("RECONLAB_WORKER_KEY（控制台「Agent 接入」里生成，勾 review 权限）")
        return miss
