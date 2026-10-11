# PhantomVeil ↔ ReconLab 对接契约 v2（设计说明）

> **机器可读的唯一事实是 `openapi.yaml`**（OpenAPI 3.1）。本文件讲**为什么这么定**、
> 两边各自要守什么。两者冲突时以 `openapi.yaml` 为准，改词表/字段先改 yaml。

- 契约版本：`2`
- 唯一接触面：HTTP + JSON，鉴权用 `Authorization: Bearer rlk_...`（Agent 专用 API Key）
- 自描述入口：`GET /api/contract/meta`（词表、映射、限制、错误码、端点清单）
- 兼容期：v1 的集合接口（`/api/collections/review_queue/records`）继续可用，两条路并行，
  两边可以错开升级。新接口只认 v2，带 `X-Contract-Version: 1` 请求新接口会拿到 400。

### 修订记录

| 日期 | 变更 | 兼容性 |
|---|---|---|
| 2026-10-07 | 新增 `GET /api/verification/queue/{id}`（**纯只读**：不要求租约、不续租、不推 `rev`、支持 `If-None-Match` → 304）；`412` 响应体明确 `data.current_etag` + `ETag` 头 | **纯新增 + 补文档，非 breaking**，契约版本仍是 `2`。PhantomVeil 侧不必等，先按现有 re-claim / `current_etag` 姿势接，接完再把预检换成 GET |

---

## 一、状态：对外 5 态当视图，站内复核机保留

对外**只有 5 个词**，PhantomVeil 只认这 5 个：

| 对外状态 | 含义 | 可写？ |
|---|---|---|
| `suspected` | 待验证，可以被领取 | 可写（退回待验证；终态记录不行） |
| `testing` | 验证中（被人领走 / 平台复核进行中） | 可写（表示"我在验"，需持租约） |
| `confirmed` | 已确认（终态） | 可写（必须带复现步骤 + 证据，过判定准则） |
| `rejected` | 已否定（终态，输出被编码/转义/不可达） | 可写（必须写清否定依据） |
| `inconclusive` | 无法判定（环境受限 / 未投递成功） | 可写（必须写清卡在哪） |

站内的复核状态机（`new → normalized → awaiting_human → auto_verified → confirmed/rejected/uncertain/retest`）
**属于 ReconLab 内部治理，不对外暴露**。它承载的是「压假阳性」那套复核位，所以不合并、不简化。

两边的对应关系：

| 内部状态 | 对外视图 | 说明 |
|---|---|---|
| `new` / `normalized` | `suspected`（被领走时 `testing`） | 刚入库、降噪完，等验证 |
| `retest` | `suspected`（被领走时 `testing`） | 环境变了，退回重新入队 |
| `awaiting_human` | `testing` | 自动证伪跑完，等人工判定 |
| `auto_verified` | 按 `verdict` 收敛：`confirmed` / `rejected` / `inconclusive`（`need_retest` → `suspected`） | **Agent 的判定落点** |
| `uncertain` | `inconclusive` | 证据不足 |
| `confirmed` / `rejected` | 同名 | 人工签字后的终态 |

**Agent 回写判定时，内部一律落 `auto_verified`**——也就是「Agent 独立复现过，等人工签字」。
这样报告主文依然只出人工签字过的 `confirmed`，假阳性卖点不受影响；对 Agent 而言，
它写进来的 `confirmed` 读回去还是 `confirmed`，不会看到内部状态的细节。

另外每条记录带一个信息性字段 `review_status`（`not_started` / `pending_platform_review` /
`signed_off`），Agent 想在前端显示"平台复核中"可以用它，但它不是状态，不参与流程判断。

---

## 二、一个完整的验证回合

```
1) GET  /api/verification/queue?state=suspected&kind=open_redirect&limit=20   # 挑活（浏览用）
2) POST /api/verification/queue/{id}/claim            {worker_id, lease_seconds}
                                                      → {lease_token, lease_expires_at, item}
3) ...独立复现（自己发请求，逐跳走 /api/scope/check 校验范围）...
4) POST /api/evidence                                 # 先传证据拿 evidence.id
4.5) GET /api/verification/queue/{id}                 # 提交前预检：拿最新 etag（只读，不动租约）
5) PATCH /api/verification/queue/{id}   If-Match: <etag>
       {state:"confirmed", verdict_note, reproduction_steps, evidence:[{id}], lease_token, confidence}
6) （长任务中途）POST /api/verification/queue/{id}/heartbeat  {lease_token, lease_seconds}
   （干不完）    POST /api/verification/queue/{id}/release    {lease_token, reason}
    （吃 412）   从响应 data.current_etag 拿新版本 → 合并本地改动 → 重发（复用同一个幂等键）
```

要点：

- **第 1 步只是浏览，不授予处理权**。真正干活前必须 claim，否则 PATCH 会被 409 拒掉。
- 第 4.5 步是**可选**的预检，用来把 412 概率压低；它**不保证**一定不冲突（预检到提交之间还有窗口），
  正确性靠第 5 步的 `If-Match` + 412 分支。没有它也能跑，先按现在的 re-claim / `data.current_etag` 姿势接就行。
- 第 5 步的 `If-Match` 用第 1 步、第 4.5 步或 claim 返回的 `etag` 原样回传，三者同源。
- 吃 412 之后的姿势（重拉 → 确认租约还在 → **合并在刚拉到的版本上** → 复用同一个幂等键重发，
  退避有上限）在第六节和第十二节写死了，别自己另发明一套。
- 每步的响应都带 `contract_version: 2`，方便前期排查。

---

## 三、授权范围：`scope_id` 只是索引，不是凭证

服务端**从不相信客户端传来的 `scope_id`**——每个写入点都拿 `target` / `endpoint` **现算匹配**。
`scope_id` 只用来把记录关联到某份授权，方便审计。

匹配规则（写死了，别自己实现一套）：

| 资产类型 | 规则 |
|---|---|
| `domain` | **点边界**后缀匹配：`example.com` 命中 `example.com` 与 `a.example.com`，**不命中** `notexample.com` |
| `ip_cidr` | IPv4 CIDR 包含判断（`ip` 是 `ip_cidr` 的别名，写单个 IP 就是精确匹配） |
| `url_prefix` | 规范化后按**段边界**前缀匹配；规范化时先解码百分号、折叠重复斜杠、**出现 `..` 直接判越界** |

时限与链路：

- 三个点都校验时效：**claim、heartbeat、提交判定**。中途过期 → 任务作废（409 `SCOPE_EXPIRED`），
  记录退回待验证，等授权续期后重新入队。
- **重定向每一跳都要过范围**：把整条跳转链丢给 `POST /api/scope/check`，任何一跳越界立刻中止，
  不要继续跟。服务端逐跳返回结果，越界那跳会标明原因。

---

## 四、并发：claim / lease / heartbeat / release

- 领取返回 `lease_token`，默认 900 秒，最长 3600 秒；多人抢同一条，后到的拿 409 `ALREADY_CLAIMED`。
- 心跳续租必须带当前 `lease_token`。
- **租约超时被回收后，旧 `lease_token` 立即作废**：拿旧 token 回来续租或提交，一律 409 `LEASE_EXPIRED`。
  这条是硬约束——不能让"超时被回收 + 原 worker 补写"把结果串起来（那比不加锁还乱）。
- 干不完就 release，把记录退回待验证，别让它挂到你租约超时。
- ⚠️ **`claim` 是写操作，不是读操作**：同 worker 重复 claim 会**续租**；租约已经超时被回收时，
  它会**换发一个新 `lease_token`**。所以重复 claim 必须**用返回值覆盖本地 token**，
  继续用旧 token 提交/续租一律 409。需要"读一下最新内容"就调
  `GET /api/verification/queue/{id}`（见第六节），别拿 claim 当读接口使。

---

## 五、幂等：键必须客户端生成

- 写接口（`POST /api/verification/queue`）**必须带 `Idempotency-Key`**，值用客户端生成的**稳定 UUID**，
  **重试时原样复用**。
- 同一个 key 同内容 → 直接回放首次结果（响应头 `Idempotent-Replay: true`），不新建记录。
- 同一个 key 不同内容 → 409 `IDEMPOTENCY_CONFLICT`。
- ⚠️ **不要拿内容哈希当幂等键**：包里多一个 timestamp 或字段顺序变一下，键就变了，幂等直接失效。
  内容哈希在服务端只用来判断"同一个 key 是不是同一个请求"。
- 证据上传不用 key：内容寻址，同一个 sha256 天然只留一条记录。

## 六、乐观锁：ETag 是服务端的内容版本

- 每条记录的 `etag` 形如 `"<id>-<rev>"`，`rev` 只在**对 Agent 可见的内容**变化时 +1。
- **租约、心跳、内部回填推不动 `rev`**，所以正常干活不会因为服务端自己写了个时间戳就莫名吃 412。
- `PATCH` 不带 `If-Match` → 428；带了但对不上 → 412 `PRECONDITION_FAILED`（重新拉一次再回写）。
- 不要把客户端自己算的 sha256 拿去当 `If-Match`。

### 6.1 写之前怎么拿"最新 etag"——三条路，分工别搞混

| 来源 | 性质 | 用途 |
|---|---|---|
| `GET /api/verification/queue/{id}` | 纯只读：不要求租约、不续租、不推 `rev` | **主路径**：提交前预检、控制台看详情 |
| 412 响应体 `data.current_etag`（同时回 `ETag` 头） | 冲突时服务端主动告诉你 | **恢复路径**：吃 412 后不用再跑一趟读 |
| 重复 `claim`（同 worker） | **写操作**：会续租，租约过期时会换发新 token | **兜底路径**：只想"一次性对齐租约活性 + 内容版本"时才用 |

- 三条路拿到的 etag 都是同一个算法算的，**可以互相替代**，不存在"哪个更权威"。
- 预检只能**降低** 412 概率，不能消灭：预检到提交之间照样有窗口。正确性靠
  `If-Match` + 412 分支，不靠预检。
- 用重复 `claim` 当读接口有两个副作用：① 把租约心跳推着走，会掩盖真实的租约超时；
  ② 租约已过期时它换发新 token，你继续用旧 token 写就 409 `LEASE_EXPIRED`。
  要读就用 GET。

### 6.2 412 恢复：一次 GET 就够，不用 re-claim

`GET /api/verification/queue/{id}` 的 `item.lease` 会给出 `{active, holder, expires_at}`，
加上 `etag`，**一次请求同时拿到"内容版本"和"租约还在不在"**：

```
吃到 412
  → GET /api/verification/queue/{id}                       # 只读，不动租约
  → item.lease.active == false 或 item.lease.holder != 我的 worker_id
        ⇒ 放弃本次提交，这轮判定别落库；回队列重新 claim（注意用返回的新 token 覆盖本地）
  → lease 还在我手上
        ⇒ 把本地改动合并到刚拿到的这版内容上 → 用返回的 etag 重发
        ⇒ 复用同一个 Idempotency-Key → 退避上限 3 次，还冲突就上报
```

⚠️ **实测过的一个坑（别踩）**：拿 `claim` 当"刷新 etag"的手段，在**租约已过期**的场景下，
服务端会**换发一个新 `lease_token`**（HTTP 200 看起来一切正常），而旧 token 当场作废。
此时若还拿旧 token 提交 → 409 `LEASE_EXPIRED`。
实测记录：`token2 != token1`，旧 token 写入 409，新 token 写入 200。
所以凡是重复 `claim`，返回的 `lease_token` **必须覆盖本地变量**。

## 七、证据通道：两步式 + 双向校验

```
1) POST /api/evidence
   Content-Digest: sha-256=:<BASE64>:   (或 X-Content-SHA256: <hex>，或 body.sha256)
   { "content_base64": "...", "content_type": "text/plain",
     "kind": "http_exchange", "note": "对照组未跳转", "filename": "exchange.txt" }
   → 201 { evidence: { id, sha256, size, ... }, digest_verified: true }

2) 假设上报 / 判定回写时只引用 evidence_ids: [{id, sha256}]
```

- **定死一个通道：JSON + base64**（不用 multipart 的"或"，别猜）。
- 摘要指的是**证据文件内容**的 sha-256（不是 HTTP body 的摘要）。
- 服务端收下来算一次、落盘后回读再算一次，任何一次对不上就拒收（400 `DIGEST_MISMATCH`）。
  客户端声明的 sha256 会被拿去比对，这样"传输没截断"才是真校验过的。
- `id` 由**服务端发号**，上报时只引用，避免两端撞号。
- 重复上传同一份内容 → 返回已有 `evidence.id`，`deduplicated: true`。
- 取回：`GET /api/evidence/{id}/raw` 返回 base64 + 自算 sha256（`sha256_match` 可判断一致性）；
  人工复核在控制台直接看 `file_url`。

## 八、判定准则表（decision rubric）

"打过去没反应"到底算 `rejected` 还是 `inconclusive`——这件事以前没有答案，现在写进表里，
两边共用同一套门槛。PhantomVeil 的验证插件直接按这张表写判定逻辑。

`GET /api/rubrics` 拿全部；`GET /api/rubrics/{kind}` 拿单个。当前内置：

| kind | 置信度门槛 | 确认必须做到的 | 典型否定原因 |
|---|---|---|---|
| `reflected_xss` | 60 | reproduce + control | encoded / escaped / not_reflected / csp_blocked |
| `stored_xss` | 65 | reproduce + control + cross（二次会话仍存在） | not_persisted / sanitized_on_render |
| `sql_injection` | 70 | reproduce + control + active（延迟基线 + 二轮一致） | parameterized / no_diff / control_same / cached_response |
| `command_injection` | 70 | reproduce + control（回显或带外证据） | escaped / not_executed / no_diff |
| `ssrf` | 65 | reproduce + control（回连/带外证据） | no_callback / filtered / client_side_only |
| `open_redirect` | 60 | reproduce + control（对照组不跳 + 试验组站外 302） | no_redirect / whitelisted / control_also_redirects / relative_only |
| `path_traversal` | 65 | reproduce + control（读到范围外文件特征） | normalized / not_found / no_diff |
| `idor` | 65 | reproduce + control + cross（两个身份对比） | owner_only / public_by_design / no_diff |
| `broken_access_control` | 60 | reproduce + control（拿到业务数据） | denied / same_as_public / requires_login |
| `xxe` | 65 | reproduce + control（文件内容或带外） | entities_disabled / not_xml |
| `default`（兜底） | 50 | reproduce + 至少一条证据 | 没有专属准则的 kind 走这条 |

`enforce: true` 的条目在 API 层**硬拦**（422 `RUBRIC_VIOLATION`，响应里给出 `errors[]`）；
`enforce: false` 的只回 `warnings[]`，不挡写入。表在控制台 `判定准则` 页可以改，改完两边立刻生效。

`rejected` / `inconclusive` 建议带 `reason_code`（取值就是上表里的原因词），
这样统计"为什么没打出来"才有意义。

## 九、终态与重开：不改历史，开新记录

- 人工签字后的 `confirmed` / `rejected` **不能原地回退**：PATCH 会被 409 `TERMINAL_IMMUTABLE`。
- 现实里会上 WAF、环境会变、结论会被推翻，所以留了重开路径：
  **POST 一条新记录并带 `supersedes: <旧 id>`**，旧记录被写上 `superseded_by` 并冻结，
  新记录带 `supersedes` 指向旧记录 —— 证据链不断，历史不被篡改。
- 对已冻结的记录回写 → 409 `ALREADY_SUPERSEDED`。

## 十、数值约定（别各写各的）

- **时间**：一律带时区的 ISO8601（`2026-10-07T19:00:00+08:00` 或 `...Z`），不用 epoch。
- **分页**：`limit` + 不透明 `cursor`，响应给 `next_cursor`（`null` 表示到底）。**不要自己拼游标**。
- **排序**：默认 `created` 升序；可选 `created` / `-created` / `confidence` / `-confidence`。
- **限流**：默认 **60 req/min/worker**，超限 429 + `Retry-After`（秒）。按它退避即可。
- **端点规范化**：丢 query / fragment / 凭据，小写 scheme 与 host，去掉默认端口（80/443），
  折叠重复斜杠，去掉尾部斜杠，路径里出现 `..` 直接判不可信。去重统计都按规范化结果算，
  不按原始 URL。

## 十一、错误码（按 code 判断，别按 message）

| HTTP | code | 处理建议 |
|---|---|---|
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | 补上 key 再发；重试必须复用同一个 key |
| 400 | `DIGEST_REQUIRED` / `DIGEST_INVALID` | 证据上传补内容摘要 |
| 400 | `DIGEST_MISMATCH` | 内容真的不一致，重新读文件重传（别重试同一份） |
| 400 | `CONTRACT_VERSION_UNSUPPORTED` | v1 走老集合接口，别带 v1 头打新接口 |
| 401 | `UNAUTHORIZED` / `AGENT_KEY_INVALID` / `AGENT_DISABLED` | Key 问题，找控制台 `/agent` 页确认状态 |
| 403 | `OUT_OF_SCOPE` | 目标不在授权范围：停下，别重试；先补授权范围 |
| 403 | `PERMISSION_DENIED` | 这个 Key 没有对应权限（ingest / review） |
| 404 | `NOT_FOUND` / `EVIDENCE_NOT_FOUND` | 记录被清掉了，重新拉一次队列 |
| 409 | `ALREADY_CLAIMED` | 别人在验，跳过这条去领下一条 |
| 409 | `LEASE_EXPIRED` / `NO_LEASE` | 租约没了，重新 claim（**不要拿旧 token 硬试**） |
| 409 | `SCOPE_EXPIRED` | 任务作废：授权在验证途中失效，这条退回队列 |
| 409 | `TERMINAL_IMMUTABLE` | 已签字定论，要推翻用 `supersedes` 开新记录 |
| 409 | `ALREADY_SUPERSEDED` | 这条被新记录取代了，去更新 `superseded_by` 指的那条 |
| 409 | `ALREADY_FINAL` | 终态记录不用再验 |
| 409 | `IDEMPOTENCY_CONFLICT` | 同一个 key 被用于不同内容：换 key 或者恢复原请求体 |
| 412 | `PRECONDITION_FAILED` | 内容被改过：从 `data.current_etag`（或 `ETag` 头）拿新版本，重新拉一次再回写 |
| 422 | `RUBRIC_VIOLATION` | 判定准则没过，响应 `data.errors[]` 里有具体哪条不满足 |
| 422 | `INVALID_STATE_TRANSITION` | 状态迁移不允许，看 `data.allowed` |
| 428 | `PRECONDITION_REQUIRED` | 忘了带 `If-Match` |
| 429 | `RATE_LIMITED` | 按 `Retry-After` 退避 |
| 5xx | `INTERNAL` / `SAVE_FAILED` / `QUERY_FAILED` | 指数退避重试；带 `Idempotency-Key` 不会重复建记录 |

## 十二、PhantomVeil 侧要守的清单

1. 用 API Key 鉴权，不要走控制台账号密码。
2. 上报一律带稳定 UUID 的 `Idempotency-Key`；重试复用同一个 key、原样请求体。
3. 干活前必须 claim，中途心跳，干不完 release；**不要拿被回收的旧 token 硬写**。
4. 发请求前自己先看一眼范围；**重定向每一跳**都过 `/api/scope/check`，越界立刻中止。
5. `confirmed` 一律带复现步骤 + 证据；`rejected` / `inconclusive` 一律写清依据和 `reason_code`。
6. 三种判定都按判定准则表里的门槛来（`enforce` 的会被硬拦）。
7. 时间用带时区的 ISO8601；分页只用服务端给的 cursor。
8. 收到 429 按 `Retry-After` 退避，别硬刷。
9. **要读就调 `GET /api/verification/queue/{id}`**（只读、不推 `rev`）；别拿重复 `claim` 当读接口——
   它会续租，租约已过期时还会换发新 token，必须用返回值覆盖本地 token。
10. **412 恢复姿势**（不是"等一下重发一遍"）：
    从 `data.current_etag` 拿新版本 → 先确认租约还在（不在就放弃本次提交、回队列重新 claim，
    这轮判定别落库）→ **把本地改动合并到刚拉到的版本上再写**（别拿旧快照整个覆盖）→
    复用同一个 `Idempotency-Key` 重发 → 退避有上限（比如 3 次），连着吃 412 就退避 + 上报，别死循环。

## 十三、ReconLab 侧已经做到的

- 三个语义化接口 + 领取/心跳/释放，Agent 不碰底层表。
- scope 现算校验（claim / heartbeat / 提交三点都过），越界与过期都留审计。
- 幂等键、乐观锁、租约回收后的 token 作废，全部有端到端用例覆盖
  （`scripts/contract_e2e_test.py`，43 项断言）。
- 证据摘要双向校验（收下来算一次 + 落盘回读再算一次）。
- 判定准则表可编辑，改完两边立刻生效。

---

## 十四、跑一遍自检

```bash
bash scripts/setup-local.sh                      # 起后端 + 建表
python3 scripts/upgrade_contract_v2.py \
    --url http://127.0.0.1:8090 \
    --email admin@reconlab.local --password reconlab123   # 老库补字段 + 灌判定准则
python3 scripts/contract_e2e_test.py --url http://127.0.0.1:8090   # 43 项契约自检
```

契约自检最后打印「通过 N 项 / 失败 0 项」才算契约层是好的。
