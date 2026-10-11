import { useCallback, useEffect, useState } from 'react';
import {
  Plug, Terminal, KeyRound, Plus, Trash2, Radio, Download, ShieldCheck, RotateCcw,
} from 'lucide-react';
import {
  allRecords, createRecord, deleteRecord, updateRecord, type AgentRecord, type ReviewItem,
} from '../lib/api';
import { CopyButton, EmptyState, Modal, Select, Spinner, TextInput, notify, fmtRelative } from '../components/kit';

type Mode = 'verifier' | 'collector' | 'both';

const MODE_LABEL: Record<Mode, { label: string; desc: string; scopes: string }> = {
  verifier: { label: '验证器', desc: '拉待验证队列 → 独立复现 → 回写判定 + 证据链', scopes: 'review' },
  collector: { label: '采集端', desc: '自己跑出来的结果上报入库（自动降噪/去重/分级）', scopes: 'ingest' },
  both: { label: '两者兼做', desc: '既上报发现，也接验证任务', scopes: 'ingest,review' },
};

/* ── 密钥生成：明文只在浏览器里出现一次，库里只落 sha256 ── */

async function sha256Hex(text: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('当前环境不支持安全随机（需要 https 或 localhost）');
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomKey(): string {
  if (!globalThis.crypto?.getRandomValues) throw new Error('当前环境不支持安全随机');
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `rlk_${Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function CodeBlock({ title, code, lang }: { title: string; code: string; lang?: string }) {
  return (
    <div className="hud-panel overflow-hidden">
      <div className="panel-head">
        <Terminal size={13} />{title}
        {lang && <span className="chip ml-1">{lang}</span>}
        <span className="ml-auto"><CopyButton text={code} /></span>
      </div>
      <div className="terminal" style={{ maxHeight: 340 }}>{code}</div>
    </div>
  );
}

export function AgentAccessPage() {
  const [loading, setLoading] = useState(true);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [queue, setQueue] = useState<ReviewItem[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ name: '', mode: 'verifier' as Mode, note: '' });
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ name: string; key: string } | null>(null);
  const [tab, setTab] = useState<'py' | 'curl' | 'jsonl'>('py');

  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://reconlab-4c03.web.zaka.live';

  const load = useCallback(async () => {
    const [agentList, pending] = await Promise.all([
      allRecords<AgentRecord>('agents', { sort: '-last_seen', perPage: 100 }, 200).catch(() => [] as AgentRecord[]),
      allRecords<ReviewItem>('review_queue', { sort: '-created', perPage: 100 }, 200).catch(() => [] as ReviewItem[]),
    ]);
    setAgents(agentList);
    setQueue(pending);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const createAgent = async () => {
    if (!form.name.trim()) { notify('给 Agent 起个名', 'err'); return; }
    setBusy(true);
    try {
      const key = randomKey();
      const hash = await sha256Hex(key);
      await createRecord<AgentRecord>('agents', {
        name: form.name.trim(),
        identity: `key:${key.slice(0, 12)}`,
        scopes: MODE_LABEL[form.mode].scopes,
        status: 'offline',
        mode: form.mode,
        ingested: 0,
        verified: 0,
        note: form.note.trim(),
        api_key_hash: hash,
        key_prefix: key.slice(0, 16),
        key_created: new Date().toISOString(),
      } as unknown as Partial<AgentRecord>);
      setCreateOpen(false);
      setForm({ name: '', mode: 'verifier', note: '' });
      setIssued({ name: form.name.trim(), key });
      await load();
    } catch (err) {
      notify(err instanceof Error ? err.message : '创建失败', 'err');
    } finally {
      setBusy(false);
    }
  };

  const rotateKey = async (agent: AgentRecord) => {
    try {
      const key = randomKey();
      const hash = await sha256Hex(key);
      await updateRecord('agents', agent.id, {
        api_key_hash: hash, key_prefix: key.slice(0, 16), key_created: new Date().toISOString(),
      } as unknown as Partial<AgentRecord>);
      setIssued({ name: agent.name, key });
      await load();
    } catch { notify('轮换失败', 'err'); }
  };

  const revoke = async (agent: AgentRecord) => {
    try {
      await updateRecord('agents', agent.id, { status: 'revoked', api_key_hash: '' });
      notify('已吊销密钥：这把 Key 立刻失效', 'ok');
      await load();
    } catch { notify('操作失败', 'err'); }
  };

  const removeAgent = async (agent: AgentRecord) => {
    try {
      await deleteRecord('agents', agent.id);
      notify('已移除登记', 'ok');
      await load();
    } catch { notify('移除失败', 'err'); }
  };

  const KEY = '<你的 rlk_ API Key>';
  const pySample = `# reconlab_agent_sdk.py — 契约 v2 参考实现，零依赖（标准库）
# 直接下：${origin}/agent/reconlab_agent_sdk.py
from reconlab_agent_sdk import ReconLabAgent, check_rubric

agent = ReconLabAgent("${origin}", api_key="${KEY}")

# 1) 先读契约自描述（词表 / 状态映射 / 限制 / 错误码都在里面）
meta = agent.meta()
print(meta["states"]["external"])          # ['suspected','testing','confirmed','rejected','inconclusive']

# 2) 挑活 → 显式领取（不领取直接回写会被 409 拒掉）
items, cursor = agent.list_queue(state="suspected", kind="open_redirect", limit=20)
for item in items:
    lease = agent.claim(item["id"], worker_id="phantomveil-01", lease_seconds=900)
    if not lease:
        continue                            # 别人领走了 / 已终态，跳过

    # 3) 自己独立复现（这一步是你的活）
    #    重定向链路每一跳都要过范围校验，越界立刻中止
    in_scope, hops = agent.check_scope([
        f'{item["endpoint"]}?next=https://evil.example',
        "https://evil.example/x",
    ])
    if not in_scope:
        agent.release(item["id"], reason="redirect_out_of_scope")
        continue

    # 4) 证据先上传拿 id（服务端会自算 sha256 比对）
    ev = agent.upload_evidence(
        open("exchange.txt", "rb").read(),
        kind="http_exchange", note="对照组未跳转 / 试验组站外 302", filename="exchange.txt")

    # 5) 按判定准则自检一遍，再回写（少挨 422）
    rubric = agent.rubric(item["kind"])
    steps = ["GET /go?next=https%3A%2F%2Fevil.example → 302 Location: https://evil.example",
             "对照组 next=/local 仅站内跳转"]
    issues = check_rubric(rubric, "confirmed", reproduction_steps=steps,
                          evidence=[ev], confidence=90,
                          checks=[{"id": "reproduce", "state": "pass"},
                                  {"id": "control", "state": "pass"}],
                          verdict_note="对照组未跳转，试验组触发站外 302")
    if issues:
        print("判定准则没过：", issues); continue

    agent.write_verdict(item["id"], lease, state="confirmed",
                        verdict_note="对照组未跳转，试验组触发站外 302",
                        reproduction_steps=steps, evidence=[ev], confidence=90,
                        checks=[{"id": "reproduce", "state": "pass"},
                                {"id": "control", "state": "pass"}])

# 6) 采集端批量上报（自动带幂等键，重试不会重复建记录）
agent.report("sql_injection", "https://t.example.com/api/user?id=1", target="t.example.com",
             parameter="id", location="query", severity="high", confidence=55,
             raw_request="GET /api/user?id=1 HTTP/1.1", raw_response="<命中响应原文>")`;

  const curlSample = `# 契约 v2：Agent 用 API Key，不走账号密码
KEY='${KEY}'
BASE='${origin}'

# 契约自描述（写对接先读这个）
curl -s "$BASE/api/contract/meta" -H "Authorization: Bearer $KEY" | jq '{contract_version, states, limits}'

# 拉待验证队列（state 只认对外 5 态；cursor 分页，别自己拼）
curl -s "$BASE/api/verification/queue?state=suspected&limit=20" \\
  -H "Authorization: Bearer $KEY" | jq '.items[] | {id,kind,state,endpoint,location,confidence}'

# 显式领取（并发安全：别人在验拿 409 ALREADY_CLAIMED）
curl -s -X POST "$BASE/api/verification/queue/<记录ID>/claim" \\
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \\
  -d '{"worker_id":"phantomveil-01","lease_seconds":900}' | jq '{lease_token,lease_expires_at}'

# 上传证据（内容摘要必带，服务端自算比对；同一 sha256 天然幂等）
EV=$(base64 -w0 exchange.txt)
SHA=$(sha256sum exchange.txt | cut -d' ' -f1)
curl -s -X POST "$BASE/api/evidence" -H "Authorization: Bearer $KEY" \\
  -H 'Content-Type: application/json' \\
  -d "{\\"content_base64\\":\\"$EV\\",\\"content_type\\":\\"text/plain\\",\\"kind\\":\\"http_exchange\\",\\"sha256\\":\\"$SHA\\"}" \\
  | jq '.evidence | {id,sha256,digest_verified}'

# 回写判定：If-Match 乐观锁 + 租约 token，confirmed 必须带复现步骤和证据
curl -s -X PATCH "$BASE/api/verification/queue/<记录ID>" \\
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \\
  -H 'If-Match: "<记录ID>-3"' \\
  -d '{
        "state": "confirmed",
        "verdict_note": "对照组未跳转，试验组 302 到站外",
        "reproduction_steps": ["GET /go?next=https://evil.example → 302", "对照组 /local 仅站内"],
        "confidence": 90,
        "evidence": [{"id": "<证据ID>"}],
        "checks": [{"id":"reproduce","state":"pass"},{"id":"control","state":"pass"}],
        "lease_token": "<claim 返回的 token>"
      }' | jq '.item | {id,state,review_status,etag}'

# 重定向逐跳校验（任何一跳越界就中止，别继续跟）
curl -s -X POST "$BASE/api/scope/check" -H "Authorization: Bearer $KEY" \\
  -H 'Content-Type: application/json' \\
  -d '{"urls":["https://demo.test/go?next=//evil","https://evil.example/x"]}' | jq '{in_scope,results}'`;

  const jsonlSample = `# findings.jsonl —— 一行一条，字段对齐契约 v2
{"kind":"open_redirect","endpoint":"https://demo.test/go?next=x","target":"demo.test","parameter":"next","location":"query","severity":"medium","title":"开放重定向候选","confidence":40}
{"kind":"sql_injection","endpoint":"https://demo.test/api/user?id=1","target":"demo.test","parameter":"id","location":"query","severity":"high","raw_request":"GET /api/user?id=1 HTTP/1.1","raw_response":"..."}

# 灌进去（SDK 会自动带幂等键；同内容重复上报会合并成同一条记录）
python3 reconlab_agent_sdk.py --jsonl findings.jsonl --base '${origin}' --api-key '${KEY}'`;

  if (loading) return <div className="grid place-items-center py-24"><Spinner label="正在读取 Agent 名册…" /></div>;

  const active = queue.filter((q) => q.state === 'awaiting_human' || q.state === 'auto_verified' || q.state === 'retest');
  const leased = queue.filter((q) => q.lease_expires_at && q.claimed_by);

  return (
    <div className="flex flex-col gap-3">
      <div className="hud-panel p-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Plug size={15} className="text-[var(--accent)]" />
          <span className="title-sm">Agent 接入（契约 v2）</span>
          <span className="chip chip-accent">对外 5 态</span>
          <span className="chip">scope 现算校验</span>
          <span className="chip">claim/lease 并发</span>
          <span className="chip">幂等 + 乐观锁</span>
          <div className="ml-auto flex items-center gap-1.5">
            <a className="btn btn-ghost" href="/agent/reconlab_agent_sdk.py" download>
              <Download size={13} />下载 SDK
            </a>
            <a className="btn btn-ghost" href="/openapi.yaml" download>
              <Download size={13} />openapi.yaml
            </a>
            <button className="btn btn-primary" onClick={() => setCreateOpen(true)}><Plus size={13} />创建 Agent</button>
          </div>
        </div>
        <p className="dim text-xs mt-2" style={{ lineHeight: 1.7 }}>
          每个 Agent 一把独立 API Key（<span className="mono">rlk_</span> 开头，只带 ingest / review 权限），
          <b>明文只在生成那一刻显示一次</b>，库里只存 sha256。密钥泄露就地轮换。
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="hud-panel p-3"><div className="label">已登记 Agent</div><div className="stat-lg">{agents.length}</div></div>
        <div className="hud-panel p-3"><div className="label">在线</div><div className="stat-lg">{agents.filter((a) => a.status === 'online').length}</div></div>
        <div className="hud-panel p-3"><div className="label">等平台复核</div><div className="stat-lg">{active.length}</div></div>
        <div className="hud-panel p-3"><div className="label">被租约领走</div><div className="stat-lg">{leased.length}</div></div>
      </div>

      {agents.length === 0 ? (
        <EmptyState icon={<KeyRound size={26} />} title="还没有 Agent 身份"
          desc="创建一个，拿到 API Key 后就能用契约 v2 的三个接口接你的 PhantomVeil 了。"
          action={<button className="btn btn-primary" onClick={() => setCreateOpen(true)}><Plus size={13} />创建 Agent</button>} />
      ) : (
        <div className="hud-panel overflow-hidden">
          <div className="panel-head"><Radio size={13} />Agent 名册</div>
          <div className="flex flex-col">
            {agents.map((agent) => (
              <div key={agent.id} className="flex items-center gap-2 flex-wrap px-3 py-2 border-b border-[var(--line)] last:border-b-0">
                <span className="text-sm">{agent.name}</span>
                <span className={`chip ${agent.status === 'online' ? 'chip-accent' : agent.status === 'revoked' ? 'chip-warn' : ''}`}>
                  {agent.status || 'offline'}
                </span>
                <span className="chip">{agent.mode ? MODE_LABEL[agent.mode]?.label : (agent.scopes || '—')}</span>
                {agent.key_prefix && <span className="chip mono">{agent.key_prefix}…</span>}
                <span className="dim text-xs">最后活跃 {fmtRelative(agent.key_last_used || agent.last_seen)}</span>
                <div className="ml-auto flex items-center gap-1.5">
                  <button className="btn btn-ghost" onClick={() => void rotateKey(agent)}><RotateCcw size={13} />轮换 Key</button>
                  <button className="btn btn-ghost" onClick={() => void revoke(agent)}><ShieldCheck size={13} />吊销</button>
                  <button className="btn btn-ghost" onClick={() => void removeAgent(agent)}><Trash2 size={13} /></button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <button className={`btn ${tab === 'py' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('py')}>Python SDK</button>
        <button className={`btn ${tab === 'curl' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('curl')}>curl</button>
        <button className={`btn ${tab === 'jsonl' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('jsonl')}>JSONL 批量</button>
      </div>

      {tab === 'py' && <CodeBlock title="完整对接流程（SDK v2）" code={pySample} lang="python" />}
      {tab === 'curl' && <CodeBlock title="三个接口 + 领取 + 证据" code={curlSample} lang="bash" />}
      {tab === 'jsonl' && <CodeBlock title="批量上报" code={jsonlSample} lang="jsonl" />}

      <div className="hud-panel p-3">
        <div className="title-sm mb-2">契约要点（踩过的坑都在这）</div>
        <ul className="text-xs flex flex-col gap-1.5" style={{ lineHeight: 1.8 }}>
          <li>· <b>对外只有 5 个状态</b>：suspected / testing / confirmed / rejected / inconclusive。站内复核状态机不对外。</li>
          <li>· <b>干活前必须 claim</b>，中途 heartbeat，干不完 release。租约被回收后旧 token 一律作废（409 LEASE_EXPIRED）。</li>
          <li>· <b>上报必须带 Idempotency-Key</b>（稳定 UUID，重试原样复用），<b>回写必须带 If-Match</b>（乐观锁）。</li>
          <li>· <b>scope_id 只是索引不是凭证</b>：服务端按 target/endpoint 现算，claim / heartbeat / 提交三个点都校验时效。</li>
          <li>· <b>重定向每一跳都要过范围</b>：用 <span className="mono">POST /api/scope/check</span>，越界立刻中止。</li>
          <li>· <b>证据两步式</b>：先 <span className="mono">POST /api/evidence</span>（必须带内容摘要，服务端自算比对），再引用 evidence.id。</li>
          <li>· <b>终态不可原地回退</b>：要推翻已签字结论，POST 一条带 <span className="mono">supersedes</span> 的新记录，证据链不断。</li>
          <li>· 判定门槛在「判定准则」页可改，<b>两边共用同一张表</b>，enforce 的会被服务端硬拦。</li>
        </ul>
      </div>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="创建 Agent 身份"
        footer={
          <div className="flex justify-end gap-2">
            <button className="btn btn-ghost" onClick={() => setCreateOpen(false)}>取消</button>
            <button className="btn btn-primary" disabled={busy} onClick={() => void createAgent()}>
              {busy ? '生成中…' : '生成 API Key'}
            </button>
          </div>
        }>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="label">名称</span>
            <TextInput value={form.name} placeholder="phantomveil-01"
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">角色</span>
            <Select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as Mode })}>
              {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
                <option key={m} value={m}>{MODE_LABEL[m].label} —— {MODE_LABEL[m].desc}</option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">备注</span>
            <TextInput value={form.note} placeholder="跑在哪台机器 / 干什么用"
              onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </label>
          <p className="dim text-xs">权限范围：<span className="mono">{MODE_LABEL[form.mode].scopes}</span></p>
        </div>
      </Modal>

      <Modal open={!!issued} onClose={() => setIssued(null)} title="API Key 已生成 —— 只显示这一次"
        footer={<div className="flex justify-end"><button className="btn btn-primary" onClick={() => setIssued(null)}>我已保存</button></div>}>
        {issued && (
          <div className="flex flex-col gap-3">
            <p className="text-sm" style={{ lineHeight: 1.7 }}>
              <b>{issued.name}</b> 的密钥。服务端只存哈希，<b>关掉这个窗口就再也拿不回来了</b>；
              丢了就在名册里点「轮换 Key」重新发一把（旧 Key 立刻失效）。
            </p>
            <div className="terminal break-all" style={{ maxHeight: 120 }}>{issued.key}</div>
            <div className="flex items-center gap-2">
              <CopyButton text={issued.key} label="复制 Key" />
              <span className="dim text-xs">建议直接写进环境变量 RECONLAB_API_KEY</span>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
