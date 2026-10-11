# ReconLab 侦察实验室

## PhantomVeil 本机指挥入口（2026-10-11）

「对话式作战台」现使用 `src/pages/PhantomVeilConsole.tsx`，经 Vite `/phantomveil` 代理连接本机 PV 命令桥（8092）。支持：填写精确 URL 和任务 → 单独确认授权 → Hermes 受限工具执行一次只读 GET 与离线入口清点 → 网页显示事件、EV 哈希和中文报告。可叫停，执行记录保存在 PV 服务端。

配套仓库：[PhantomVeil](https://github.com/yrwwovo/PhantomVeil)、[Hermes 运行时](https://github.com/yrwwovo/phantomveil-hermes)。将 PhantomVeil 克隆为同级目录 `security-agent-lab`，Hermes 克隆为 `phantomveil-hermes`。先在 PV 目录运行 `npm run reconlab:bridge`，再按下文启动 PocketBase 和本项目的 `npm run dev`，登入后进入作战台。详细边界、安装布局和验收记录见 [PV 接线说明](https://github.com/yrwwovo/PhantomVeil/blob/main/docs/reconlab-command-bridge.md)。

当前只支持本机开发代理。真实模型提供方尚待验收；静态网页部署、远程用户认证、PocketBase 资产/发现/复核队列统一回写以及更广的安全任务仍未接完。下文介绍的扫描执行器与旧 Python 编排器是独立入口，不代表它们已经接入这条 PV 链路。

---

授权渗透测试作战控制台：资产测绘、任务编排、漏洞验证、中文报告，一条流水线跑完。

- **控制台**（本目录）：网页界面，负责目标管理、任务下发、结果与证据归档、报告生成
- **执行器**（`public/worker/reconlab-worker.py`）：跑在你自己机器上的单文件引擎，真正执行扫描并把结果回传

> 仅用于对**已获书面授权**的目标开展安全测试。所有任务都要求目标先登记为「授权范围内」。

---

## 目录结构

```
.
├── src/                     前端源码（React + Vite + Tailwind）
├── pb_hooks/                契约层（后端钩子：三个语义化接口 + 领取/心跳 + 证据通道）
│   ├── routes_table.pb.js   路由表
│   ├── hooks.pb.js          实体版本维护 + 定时清理
│   ├── routes/              接口实现（队列 / 证据 / 范围 / 准则）
│   └── lib/                 状态映射、范围匹配、幂等、限流、判定准则、序列化
├── openapi.yaml             对接契约（OpenAPI 3.1，机器可读的唯一事实）
├── docs/contract-v2.md      契约设计说明（为什么这么定、两边各守什么）
├── public/
│   ├── agent/reconlab_agent_sdk.py  Agent 接入 SDK（契约 v2 参考实现）
│   └── worker/reconlab-worker.py   执行器脚本（部署后可在网页里直接下载）
├── console/                 对话式作战台（LLM 编排服务，选配）
│   ├── server.py            编排服务入口（HTTP + SSE，纯标准库）
│   ├── agent/               Plan-Execute 主循环 / kill-chain 状态机 / 契约客户端 / 工具表
│   ├── selftest.py          离线端到端自测（配假模型，不需要真 Key）
│   └── .env.example         配置样例（两把 key 填这里）
├── scripts/
│   ├── setup-local.sh       本地后端一键初始化
│   ├── fixtures.py          联调夹具 + 契约实测探针
│   ├── init_pb.py           表结构导入工具（纯标准库）
│   ├── upgrade_contract_v2.py 老库升级到契约 v2（补字段 + 灌判定准则）
│   ├── rubric_seed.json     内置判定准则
│   └── contract_e2e_test.py 契约端到端自检（43 项）
├── pb_collections.json      数据表结构声明
├── vite.config.ts
└── package.json
```

## 一、本地部署（三步）

**环境要求**：Node.js 18+、Python 3.9+、能联网（首次会下载后端程序，约 15MB）

### 1. 起后端 + 建表

```bash
bash scripts/setup-local.sh
```

它会下载并启动后端（默认 `http://127.0.0.1:8090`）、创建管理员（默认 `admin@reconlab.local / reconlab123`，可用环境变量 `PB_ADMIN_EMAIL`、`PB_ADMIN_PASS` 覆盖），导入全部数据表，再补上「契约 v2」的结构（授权范围 / 证据 / 判定准则等）并灌入默认判定准则。

> **已有库升级**：老库直接跑一次
> `python3 scripts/upgrade_contract_v2.py --url http://127.0.0.1:8090 --email 管理员 --password 密码`
> 会补齐缺的字段与表、写入判定准则，**原有数据一条不动**。

### 2. 起前端

```bash
npm install
npm run dev
```

打开 `http://127.0.0.1:5173`，注册一个账号 —— 这个账号就是你的控制台登录账号。

### 3. 在你自己的机器上跑执行器

```bash
python3 public/worker/reconlab-worker.py \
  --server http://127.0.0.1:8090 \
  --email 你的邮箱 --password 你的密码 \
  --name 我的电脑
```

执行器上线后，网页右上角会显示「执行器在线」，此时下发任务就会真的开跑。

---

## 二、Agent 接入（契约 v2）

给你的验证器 / 采集端 Agent（比如 PhantomVeil）用。**唯一接触面是 HTTP + JSON**，
规格在 `openapi.yaml`（OpenAPI 3.1），设计说明在 `docs/contract-v2.md`。

### 1. 发一把 Agent 专用 Key

控制台 →「Agent 接入」→ 创建 Agent → 选角色（验证器 / 采集端 / 两者兼做）。
**Key 只显示一次**（库里只存 sha256），丢了点「轮换 Key」重发。

```bash
export RECONLAB_API_KEY='rlk_...'
python3 public/agent/reconlab_agent_sdk.py --selftest --base http://127.0.0.1:8090
```

### 2. 三个接口

| 方法 | 路径 | 干什么 |
| --- | --- | --- |
| GET | `/api/verification/queue` | 拉待验证队列（只用于浏览，干活前必须领取） |
| POST | `/api/verification/queue/{id}/claim` | 显式领取（lease），并发安全 |
| PATCH | `/api/verification/queue/{id}` | 回写判定（`If-Match` 乐观锁 + 租约） |
| POST | `/api/verification/queue` | 上报新发现（必须带 `Idempotency-Key`） |
| POST | `/api/evidence` | 证据两步式的第一步（必须带内容摘要） |
| POST | `/api/scope/check` | 授权范围校验（重定向**逐跳**用这个） |

### 3. 几个必须知道的约定

- **对外只有 5 个状态**：`suspected` / `testing` / `confirmed` / `rejected` / `inconclusive`。
  站内更细的复核状态机（含人工签字位）不对外暴露。
- **授权范围是硬边界**：`scope_id` 只是索引，服务端按 `target` / `endpoint` 现算匹配；
  域名是点边界匹配（`example.com` 不匹配 `notexample.com`），claim / heartbeat / 提交三个点都校验时效。
- **租约**：领取拿 `lease_token`，超时被回收后旧 token 立即作废；
  干不完要 `release`，别挂到超时。
- **幂等键**用客户端生成的稳定 UUID，重试原样复用；不要拿内容哈希当键。
- **乐观锁**用响应里的 `etag` 回填 `If-Match`；租约与心跳不会让 etag 变化。
- **终态不可原地回退**：要推翻已签字结论，POST 一条带 `supersedes` 的新记录，证据链不断。
- **判定门槛**在「判定准则」页可编辑，两边共用同一张表。

### 4. 契约自检

```bash
python3 scripts/contract_e2e_test.py --url http://127.0.0.1:8090
```

会临时建一个 Agent 和一条授权范围，把越界拦截、幂等、租约回收、乐观锁、判定准则、
证据摘要、范围中途失效、重定向逐跳、终态重开这 43 项全跑一遍，跑完自动清理。

---

## 三、对话式作战台（LLM 编排，选配）

用一句话驱动作战台：**挑活 → 领租约 → 判 → 留证 → 回写**。
编排跑在服务端（`console/`），模型 Key 只在服务端用，浏览器拿不到。

### 1. 起编排服务

```bash
cp console/.env.example console/.env    # 填两把 key（下面说明）
bash console/start-console.sh           # 默认 127.0.0.1:8091，端口被占会自动顺延
```

两把 key 是两回事：

| 变量 | 是什么 | 去哪拿 |
| --- | --- | --- |
| `CONSOLE_LLM_API_KEY` | 模型厂的 Key（OpenAI 兼容接口） | 你用的模型服务商 |
| `RECONLAB_WORKER_KEY` | 后端契约的 Agent Key，`rlk_` 开头 | 控制台 →「Agent 接入」→ 建一个，勾 `review`（+ `ingest`） |

前端 `npm run dev` 会把 `/console` 反代到编排服务，打开 `http://127.0.0.1:5173/#/console`。

### 2. 它守的那些规矩（写死在代码里，模型绕不过）

| 规矩 | 落点 |
| --- | --- |
| 读和租约分开：拿版本用 GET，干活前才 claim | `agent/tools.py` |
| **If-Match 与 lease_token 由编排层注入**，模型不许自己写 etag | `agent/tools.py` |
| 412 只做一件事：换 `current_etag` 重试一次，再撞弃单；**不碰租约判断** | `agent/killchain.py` |
| 409 才管租约/终态/范围：`LEASE_EXPIRED` 弃单后**不许本地重试 claim 同一条** | `agent/killchain.py` |
| `ALREADY_SUPERSEDED` 不是「重开」而是**换目标**：读 `superseded_by` → GET 新的 → 核实 state 与租约归属 | `agent/killchain.py` |
| 换目标/弃单时清空上一条的判定草稿，不串数据 | `agent/killchain.py` |
| 422 准则不过 → 回炉重判，绝不为了过闸编证据 | `agent/loop.py` |
| system 前缀逐字节冻结（契约摘要 + 工具策略）→ 吃缓存 | `agent/prompts.py` |
| 带 tools 的历史轮次**整条回传** assistant 消息（含 `reasoning_content`） | `agent/llm.py` |
| 主动探测默认关闭，`http_probe` 工具压根不暴露 | `agent/config.py` |

### 3. 不需要模型 Key 也能自测

```bash
python3 console/selftest.py --url http://127.0.0.1:8090
```

它会拉起一个"假模型"（按剧本+反应式），对着**真后端**把四条路径各跑一遍：
主路径 / 412 换 etag 重试 / 已取代换目标 / 租约被占弃单，22 项断言。

## 四、执行器说明
```
python3 reconlab-worker.py --server <控制台地址> --email <账号> --password <密码>
                           [--name 显示名] [--once] [--interval 6]
```

| 参数 | 说明 |
| --- | --- |
| `--server` | 控制台地址，本地就是 `http://127.0.0.1:8090` |
| `--once` | 只领一个任务，跑完退出（适合临时验证或放进 crontab） |
| `--interval` | 空闲时轮询间隔秒数，默认 6 |

**零第三方依赖**，标准库实现。本机若装了下面这些工具，执行器会自动识别并优先使用，没有就用内置引擎：

`nmap`、`subfinder`、`httpx`、`nuclei`、`sqlmap`、`whatweb`

内置引擎能力（无需任何外部工具）：

- **子域枚举**：字典 + DNS-over-HTTPS 解析 + 证书透明日志，自动识别泛解析
- **端口扫描**：TCP 连接扫描，常用 100 / 常见 1000 / 全端口三档，带服务识别与 banner
- **指纹探测**：状态码、标题、Server、技术栈、TLS 证书信息
- **目录爆破**：字典探测 + 404 基线长度比对去噪
- **漏洞检测**：安全头缺失、CORS 配置错误、敏感文件泄露、未授权暴露、目录遍历、SQL 注入（时间盲注 + 多轮复核）、反射型 XSS、开放重定向、危险 HTTP 方法、服务端信息泄露
- **POC 批量验证**：按 POC 库模板发请求，命中后**两轮复核**才判定，压制假阳性

> 时间盲注、XSS 这类结果对网络抖动敏感，执行器默认做两轮一致性确认；仍然建议人工复核后再标记为「已确认」。

---

## 五、常见问题

**任务一直停在「排队中」？** 说明没有执行器在线。看网页「执行器」页的接入指引，把脚本跑起来即可。

**执行器日志里提示连不上控制台？** 检查 `--server` 地址是否可访问、账号密码是否正确。

**想换后端端口？** `PB_PORT=9000 bash scripts/setup-local.sh`，并让 `VITE_PB_URL` 指向同一地址。

**数据存在哪？** 全部在 `pb_data/` 目录里，备份直接拷这个目录。

## 六、生产部署建议

1. 前端：`npm run build`，把 `dist/` 交给 Nginx 或任意静态托管
2. 后端：把 `pb_data` 和 PocketBase 二进制放到服务器常驻进程（systemd / supervisor / Docker）
3. 把 `/api` 反代到后端端口，前端与后端同域即可，无需处理跨域
4. 执行器放在**能访问目标网段**的机器上跑，控制台只负责编排与留痕

## 七、约定

- 所有任务在「授权范围内」的目标才能下发，范围外的目标会被前端拦截
- 每条发现都带请求 / 响应原文与判定依据，可复核
- 报告为中文 Markdown，可导出 Markdown / HTML（浏览器打印即为 PDF）

---

**免责声明**：本工具用于授权范围内的安全测试。使用者需自行确保对测试目标拥有合法授权，并对使用行为负责。
