#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 pb_collections.json 导入本地 PocketBase。

用法:
    python3 scripts/init_pb.py --url http://127.0.0.1:8090 \
        --email admin@reconlab.local --password reconlab123

特性: 自动把表名形式的 relation(collectionId) 换成真实集合 id，已存在的集合跳过。
纯标准库实现，无需 pip 安装任何依赖。
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
        with urllib.request.urlopen(req, timeout=20) as resp:
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8090")
    parser.add_argument("--email", default="admin@reconlab.local")
    parser.add_argument("--password", default="reconlab123")
    parser.add_argument("--file", default=os.path.join(ROOT, "pb_collections.json"))
    args = parser.parse_args()
    base = args.url.rstrip("/")

    with open(args.file, "r", encoding="utf-8") as handle:
        schemas = json.load(handle)

    token = superuser_token(base, args.email, args.password)
    if not token:
        return 1

    status, existing = request("GET", base + "/api/collections?perPage=200", token=token)
    id_by_name = {c["name"]: c["id"] for c in existing.get("items", [])}
    id_by_name[BUILTIN_USERS] = BUILTIN_USERS

    created, skipped = 0, 0
    pending = list(schemas)
    for attempt in range(5):
        deferred = []
        for schema in pending:
            name = schema["name"]
            if name in id_by_name:
                print("跳过已存在集合: %s" % name)
                skipped += 1
                continue
            payload = dict(schema)
            for field in payload.get("fields", []):
                if field.get("type") == "relation":
                    ref = field.get("collectionId")
                    if ref and ref != BUILTIN_USERS:
                        resolved = id_by_name.get(ref)
                        if not resolved:
                            print("  ! 关系目标 %s 尚未创建，%s 稍后重试" % (ref, name))
                        else:
                            field["collectionId"] = resolved
            status, result = request("POST", base + "/api/collections", payload, token=token)
            if status in (200, 201):
                id_by_name[name] = result.get("id", "")
                print("已创建集合: %s" % name)
                created += 1
                continue
            # 依赖的表还没建好 → 下一轮再来，其余错误直接报
            if attempt < 4 and "relation" in json.dumps(result).lower():
                deferred.append(schema)
                continue
            print("创建集合 %s 失败 (%s): %s" % (name, status, result))
            return 2
        pending = deferred
        if not pending:
            break
    if pending:
        print("以下集合因依赖缺失未能创建: %s" % ", ".join(s["name"] for s in pending))
        return 2

    print("\n完成: 新建 %d 个集合, 跳过 %d 个" % (created, skipped))
    print("管理后台: %s/_/" % base)
    return 0


if __name__ == "__main__":
    sys.exit(main())
