#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把已有的 ReconLab 本地库升级到「契约 v2」结构。

做三件事（幂等，可以重复跑）：
  1. 缺的表建起来（scopes / evidence / decision_rubrics / contract_audit /
     idempotency_keys / rate_buckets）
  2. 已有的表补齐缺的字段（review_queue 的 scope/租约/版本/重开链，
     agents 的 API Key 字段）—— 原有数据一条不动
  3. 灌入判定准则表默认数据（已存在的 rule_id 跳过，你自己改过的不覆盖）

用法:
    python3 scripts/upgrade_contract_v2.py --url http://127.0.0.1:8090 \
        --email admin@reconlab.local --password reconlab123

纯标准库实现，不需要 pip 装东西。
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BUILTIN_USERS = "_pb_users_auth_"


def request(method, url, body=None, token=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if token:
        headers["Authorization"] = token
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8", "replace")
        return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            payload = json.loads(raw)
        except ValueError:
            payload = {"message": raw[:300]}
        return exc.code, payload


def superuser_token(base, email, password):
    status, payload = request("POST", base + "/api/collections/_superusers/auth-with-password",
                              {"identity": email, "password": password})
    if status != 200 or not payload.get("token"):
        print("超级管理员登录失败 (%s): %s" % (status, payload))
        return None
    return payload["token"]


def resolve_relations(fields, id_by_name):
    out = []
    for field in fields:
        field = dict(field)
        if field.get("type") == "relation":
            ref = field.get("collectionId")
            if ref and ref != BUILTIN_USERS:
                resolved = id_by_name.get(ref)
                if not resolved:
                    print("  ! 关系目标 %s 不存在，字段 %s 可能建立失败" % (ref, field.get("name")))
                else:
                    field["collectionId"] = resolved
        out.append(field)
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8090")
    parser.add_argument("--email", default="admin@reconlab.local")
    parser.add_argument("--password", default="reconlab123")
    parser.add_argument("--file", default=os.path.join(ROOT, "pb_collections.json"))
    parser.add_argument("--rubrics", default=os.path.join(HERE, "rubric_seed.json"))
    parser.add_argument("--skip-rubrics", action="store_true")
    args = parser.parse_args()
    base = args.url.rstrip("/")

    with open(args.file, "r", encoding="utf-8") as handle:
        schemas = json.load(handle)

    token = superuser_token(base, args.email, args.password)
    if not token:
        return 1

    status, existing = request("GET", base + "/api/collections?perPage=200", token=token)
    if status != 200:
        print("读取表结构失败 (%s): %s" % (status, existing))
        return 1
    by_name = {c["name"]: c for c in existing.get("items", [])}
    id_by_name = {name: c["id"] for name, c in by_name.items()}
    id_by_name[BUILTIN_USERS] = BUILTIN_USERS

    created, patched, untouched = 0, 0, 0

    # 先建缺的表（按依赖顺序建，relation 才能解析到）
    for schema in schemas:
        name = schema["name"]
        if name in by_name:
            continue
        payload = dict(schema)
        payload["fields"] = resolve_relations(schema.get("fields", []), id_by_name)
        status, result = request("POST", base + "/api/collections", payload, token=token)
        if status in (200, 201):
            id_by_name[name] = result.get("id", "")
            by_name[name] = result
            print("已创建表: %s" % name)
            created += 1
        else:
            print("创建表 %s 失败 (%s): %s" % (name, status, result))
            return 2

    # 再补字段
    for schema in schemas:
        name = schema["name"]
        current = by_name.get(name)
        if not current:
            continue
        have = {f["name"] for f in current.get("fields", [])}
        missing = [f for f in schema.get("fields", []) if f["name"] not in have]
        if not missing:
            untouched += 1
            continue
        merged = list(current.get("fields", []))
        merged.extend(resolve_relations(missing, id_by_name))
        status, result = request("PATCH", "%s/api/collections/%s" % (base, current["id"]),
                                 {"fields": merged}, token=token)
        if status in (200, 201):
            print("已补字段: %s (+%s)" % (name, ", ".join(f["name"] for f in missing)))
            by_name[name] = result
            patched += 1
        else:
            print("补字段 %s 失败 (%s): %s" % (name, status, result))
            return 2

    print("\n表结构: 新建 %d / 补字段 %d / 无需改动 %d" % (created, patched, untouched))

    if args.skip_rubrics:
        return 0

    # 灌判定准则
    if not os.path.exists(args.rubrics):
        print("未找到判定准则文件，跳过")
        return 0
    with open(args.rubrics, "r", encoding="utf-8") as handle:
        rubrics = json.load(handle)

    status, existing_rubrics = request(
        "GET", "%s/api/collections/decision_rubrics/records?perPage=200" % base, token=token)
    have_rule_ids = set()
    if status == 200:
        have_rule_ids = {r.get("rule_id") for r in existing_rubrics.get("items", [])}

    added = 0
    for rule in rubrics:
        if rule["rule_id"] in have_rule_ids:
            continue
        body = dict(rule)
        body["enabled"] = True
        status, result = request("POST", "%s/api/collections/decision_rubrics/records" % base,
                                 body, token=token)
        if status in (200, 201):
            print("已写入判定准则: %s" % rule["rule_id"])
            added += 1
        else:
            print("写入准则 %s 失败 (%s): %s" % (rule["rule_id"], status, result))
    print("判定准则: 新增 %d 条（已存在的不覆盖）" % added)
    print("\n升级完成。管理后台: %s/_/" % base)
    return 0


if __name__ == "__main__":
    sys.exit(main())
