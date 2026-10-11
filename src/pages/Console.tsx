import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot, Send, Square, Plus, RefreshCw, ListTree, AlertTriangle, CheckCircle2,
  CircleDot, Wrench, ShieldCheck, Radio,
} from 'lucide-react';
import { Spinner, notify } from '../components/kit';

/**
 * 对话式作战台（做法 B：LLM 编排跑在后端 console/server.py）
 *
 * 浏览器只跟编排服务说话，模型 Key 永远不下发到前端。
 * 事件流走 SSE，编排服务把每一步（计划 / 工具调用 / 结果 / 状态机迁移）都写成事件。
 */

const CONSOLE_BASE = (import.meta.env.VITE_CONSOLE_URL as string | undefined) || '/console';

type Health = {
  llm: { provider: string; model: string; key_configured: boolean; thinking: string; strict_writeback: boolean };
  reconlab: { base_url: string; worker_id: string; key_configured: boolean; reachable?: boolean; error?: string };
  policy: { max_steps: number; allow_active_probe: boolean };
  ready: boolean;
  missing: string[];
};

type SessionRow = { id: string; title: string; status: string; updated: number };
type Ev = { seq: number; kind: string; payload: any; created: number };

const STAGES = ['QUEUED', 'PRECHECK', 'LEASED', 'PROBING', 'DECIDING', 'WRITING', 'SETTLED', 'ABANDONED'];

const STAGE_META: Record<string, { label: string; color: string }> = {
  QUEUED: { label: '待办', color: '#7d9b8a' },
  PRECHECK: { label: '预检', color: '#38bdf8' },
  LEASED: { label: '已领租约', color: '#00ff88' },
  PROBING: { label: '验证中', color: '#facc15' },
  DECIDING: { label: '判定中', color: '#facc15' },
  WRITING: { label: '回写中', color: '#c084fc' },
  SETTLED: { label: '已落库', color: '#00ff88' },
  ABANDONED: { label: '已弃单', color: '#ff2b3d' },
};

const TOOL_LABEL: Record<string, string> = {
  queue_overview: '看队列',
  item_read: '只读预检',
  item_claim: '领租约',
  item_heartbeat: '续租',
  item_release: '释放',
  item_write_verdict: '回写判定',
  evidence_submit: '传证据',
  rubric_lookup: '查判据',
  scope_check: '范围校验',
  finding_report: '上报发现',
  http_probe: '探测',
  contract_meta: '读契约',
  finish: '收尾',
};

const ACTION_LABEL: Record<string, string> = {
  retry_new_etag: '412 → 换新 etag 重试',
  follow_supersede: '已取代 → 换目标',
  re_decide: '准则不过 → 回炉',
  abandon: '弃单回队列',
  fatal: '硬错误，停手',
  retry: '退避重试',
  blocked: '被状态机拦下',
};

async function cget<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(CONSOLE_BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any)?.error || `请求失败 ${res.status}`);
  return data as T;
}

function StageRail({ snap }: { snap: Record<string, any> }) {
  const items = Object.values(snap || {});
  if (!items.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {items.map((s: any) => (
        <div key={s.item_id} style={{ border: '1px solid rgba(0,255,136,0.14)', background: 'rgba(0,255,136,0.03)', padding: '0.5rem 0.6rem' }}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="fs-tiny font-mono" style={{ color: '#b8d6c4' }}>{s.item_id}</span>
            <span className="fs-tiny font-mono" style={{ color: (STAGE_META[s.stage] || {}).color || '#7d9b8a' }}>
              {(STAGE_META[s.stage] || {}).label || s.stage}
            </span>
            {s.etag && <span className="fs-tiny font-mono" style={{ color: '#4e6b5c' }}>etag {s.etag}</span>}
            {s.etag_retries > 0 && <span className="fs-tiny font-mono" style={{ color: '#facc15' }}>412×{s.etag_retries}</span>}
            {s.abandon_reason && <span className="fs-tiny" style={{ color: '#ff2b3d' }}>{s.abandon_reason}</span>}
          </div>
          <div className="flex gap-1 mt-1 flex-wrap">
            {STAGES.map((st) => (
              <span
                key={st}
                className="fs-tiny font-mono"
                style={{
                  padding: '0 4px',
                  color: s.stage === st ? ((STAGE_META[st] || {}).color || '#00ff88') : '#3b5548',
                  borderBottom: `1px solid ${s.stage === st ? ((STAGE_META[st] || {}).color || '#00ff88') : 'transparent'}`,
                }}
              >
                {st}
              </span>
            ))}
          </div>
          {(s.history || []).slice(-3).map((h: any, i: number) => (
            <div key={i} className="fs-tiny" style={{ color: '#7d9b8a' }}>
              {h.from} → {h.to}{h.note ? `（${h.note}）` : ''}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function EventCard({ ev }: { ev: Ev }) {
  const p = ev.payload || {};
  if (ev.kind === 'plan') {
    return (
      <div className="panel" style={{ borderColor: 'rgba(56,189,248,0.25)' }}>
        <div className="flex items-center gap-2 mb-2">
          <ListTree size={14} color="#38bdf8" />
          <span className="fs-small" style={{ color: '#38bdf8' }}>计划</span>
          {p._degraded && <span className="fs-tiny" style={{ color: '#facc15' }}>（降级：模型没按 schema 出计划）</span>}
        </div>
        <div className="fs-small" style={{ color: '#cfe9db' }}>{p.intent}</div>
        <div className="fs-tiny mt-1" style={{ color: '#7d9b8a' }}>依据：{p.hypothesis}</div>
        <div className="mt-2 flex flex-col gap-1">
          {(p.steps || []).map((s: any) => (
            <div key={s.id} className="fs-tiny" style={{ color: '#b8d6c4' }}>
              <span className="font-mono" style={{ color: '#00ff88' }}>{s.id}</span> {s.goal}
              <span style={{ color: '#4e6b5c' }}> · {TOOL_LABEL[s.tool] || s.tool} · 算完成：{s.done_when}</span>
            </div>
          ))}
        </div>
        {p.stop_when && <div className="fs-tiny mt-2" style={{ color: '#4e6b5c' }}>收手条件：{p.stop_when}</div>}
      </div>
    );
  }

  if (ev.kind === 'tool_call') {
    return (
      <div className="flex items-center gap-2 fs-small" style={{ color: '#b8d6c4' }}>
        <Wrench size={13} color="#00ff88" />
        <span className="font-mono" style={{ color: '#00ff88' }}>{TOOL_LABEL[p.tool] || p.tool}</span>
        <span className="fs-tiny font-mono" style={{ color: '#4e6b5c', overflowWrap: 'anywhere' }}>
          {JSON.stringify(p.args)}
        </span>
      </div>
    );
  }

  if (ev.kind === 'tool_result') {
    const o = p.outcome || {};
    const inner = o.result || {};
    const action = o.action || (inner.action || {}).action;
    const ok = o.ok !== false;
    const code = (inner.error || {}).code;
    return (
      <div className="fs-tiny" style={{ color: ok ? '#7d9b8a' : '#ffb4b4', overflowWrap: 'anywhere' }}>
        {ok ? '↳ 完成' : '↳ 失败'}
        {code ? ` · ${code}` : ''}
        {action ? ` · ${ACTION_LABEL[action] || action}` : ''}
        {!ok && (inner.error || {}).message ? ` · ${(inner.error || {}).message}` : ''}
      </div>
    );
  }

  if (ev.kind === 'item_state') return null;

  if (ev.kind === 'assistant') {
    return (
      <div className="panel" style={{ borderColor: 'rgba(0,255,136,0.2)' }}>
        <div className="flex items-center gap-2 mb-1">
          <Bot size={14} color="#00ff88" />
          <span className="fs-small" style={{ color: '#00ff88' }}>编排 Agent</span>
        </div>
        <div className="fs-small" style={{ color: '#e8fff3', whiteSpace: 'pre-wrap' }}>{p.text}</div>
      </div>
    );
  }

  if (ev.kind === 'done') {
    return (
      <div className="panel" style={{ borderColor: 'rgba(0,255,136,0.3)' }}>
        <div className="flex items-center gap-2 mb-1">
          <CheckCircle2 size={14} color="#00ff88" />
          <span className="fs-small" style={{ color: '#00ff88' }}>本轮收尾</span>
        </div>
        <div className="fs-small" style={{ color: '#e8fff3', whiteSpace: 'pre-wrap' }}>{p.summary}</div>
      </div>
    );
  }

  if (ev.kind === 'error') {
    return (
      <div className="panel" style={{ borderColor: 'rgba(255,43,61,0.4)' }}>
        <div className="flex items-center gap-2">
          <AlertTriangle size={14} color="#ff2b3d" />
          <span className="fs-small" style={{ color: '#ffb4b4' }}>出错（{p.where}）</span>
        </div>
        <div className="fs-tiny mt-1" style={{ color: '#ffb4b4', overflowWrap: 'anywhere' }}>{p.message}</div>
      </div>
    );
  }

  if (ev.kind === 'usage') {
    const u = p.usage || {};
    return (
      <div className="fs-tiny" style={{ color: '#3b5548' }}>
        第 {p.step} 步 · 用量 {u.total_tokens ?? '-'} tokens · {p.ms}ms
      </div>
    );
  }

  if (ev.kind === 'status') {
    return (
      <div className="flex items-center gap-2 fs-tiny" style={{ color: '#7d9b8a' }}>
        <CircleDot size={11} /> {p.text || p.status}
      </div>
    );
  }

  if (ev.kind === 'tool_audit') {
    return (
      <div className="fs-tiny font-mono" style={{ color: '#3b5548', overflowWrap: 'anywhere' }}>
        [审计] {p.tool} {p.code || ''} {p.action || ''} {p.status || ''}
      </div>
    );
  }

  if (ev.kind === 'plan_fallback') {
    return <div className="fs-tiny" style={{ color: '#facc15' }}>规划降级：{p.reason}</div>;
  }

  return null;
}

export function ConsolePage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sid, setSid] = useState<string>('');
  const [events, setEvents] = useState<Ev[]>([]);
  const [messages, setMessages] = useState<any[]>([]);
  const [running, setRunning] = useState(false);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const cursor = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const loadHealth = useCallback(async () => {
    try {
      setHealth(await cget<Health>('/health'));
    } catch (e: any) {
      setHealth(null);
      notify('编排服务连不上：先起 console/server.py', 'err');
    }
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const data = await cget<{ sessions: SessionRow[] }>('/sessions');
      setSessions(data.sessions || []);
      return data.sessions || [];
    } catch {
      return [];
    }
  }, []);

  const openSession = useCallback(async (id: string) => {
    setSid(id);
    cursor.current = 0;
    setEvents([]);
    const data = await cget<{ session: SessionRow; messages: any[]; running: boolean }>(`/sessions/${id}`);
    setMessages(data.messages || []);
    setRunning(!!data.running);
    const evs = await cget<{ events?: Ev[] } & any>(`/sessions/${id}/events?after=0`).catch(() => ({ events: [] } as any));
    void evs;
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await loadHealth();
      const list = await loadSessions();
      if (list.length) await openSession(list[0].id);
      setLoading(false);
    })();
  }, [loadHealth, loadSessions, openSession]);

  // SSE：事件流
  useEffect(() => {
    if (!sid) return;
    esRef.current?.close();
    const es = new EventSource(`${CONSOLE_BASE}/sessions/${sid}/events?after=${cursor.current}`);
    esRef.current = es;
    const onMsg = (e: MessageEvent) => {
      try {
        const ev = JSON.parse(e.data) as Ev;
        cursor.current = Math.max(cursor.current, ev.seq);
        setEvents((prev) => [...prev, ev]);
        if (ev.kind === 'done' || ev.kind === 'error') setRunning(false);
      } catch { /* ignore */ }
    };
    ['status', 'plan', 'plan_fallback', 'step', 'tool_call', 'tool_result', 'tool_audit',
      'assistant', 'item_state', 'usage', 'done', 'error'].forEach((k) => es.addEventListener(k, onMsg as any));
    es.addEventListener('eof', () => {
      es.close();
      // 连上了但这一轮已经结束 → 重新拉一次全量事件，避免漏
      cget<any>(`/sessions/${sid}/events?after=0`).catch(() => null);
    });
    es.onerror = () => es.close();
    return () => es.close();
  }, [sid]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events.length, messages.length]);

  const send = async () => {
    if (!text.trim() || !sid || running) return;
    const t = text.trim();
    setText('');
    setMessages((prev) => [...prev, { role: 'user', content: t, seq: Date.now() }]);
    setRunning(true);
    try {
      await cget(`/sessions/${sid}/messages`, { method: 'POST', body: JSON.stringify({ text: t }) });
    } catch (e: any) {
      setRunning(false);
      notify(e.message || '发送失败', 'err');
    }
  };

  const newSession = async () => {
    const data = await cget<{ session: SessionRow }>('/sessions', {
      method: 'POST', body: JSON.stringify({ title: '新回合' }),
    });
    await loadSessions();
    await openSession(data.session.id);
  };

  const stop = async () => {
    if (!sid) return;
    await cget(`/sessions/${sid}/cancel`, { method: 'POST' }).catch(() => null);
    notify('已叫停', 'info');
  };

  const merged = useMemo(() => {
    const rows: Array<{ key: string; kind: 'ev' | 'msg'; at: number; ev?: Ev; msg?: any }> = [];
    events.forEach((e) => rows.push({ key: `e${e.seq}`, kind: 'ev', at: e.created || 0, ev: e }));
    messages.forEach((m, i) => {
      if (m.role === 'user') rows.push({ key: `m${m.seq || i}`, kind: 'msg', at: m.created || 0, msg: m });
    });
    return rows.sort((a, b) => a.at - b.at);
  }, [events, messages]);

  const lastSnapshot = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].kind === 'done') return (events[i].payload || {}).killchain || {};
      if (events[i].kind === 'item_state') return { [(events[i].payload || {}).item_id]: events[i].payload };
    }
    return {};
  }, [events]);

  if (loading) return <Spinner label="正在连编排服务…" />;

  return (
    <div className="section-wrap">
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <Radio size={16} color="#00ff88" />
        <h1 className="fs-heading" style={{ color: '#e8fff3' }}>对话式作战台</h1>
        <span className="fs-tiny" style={{ color: '#4e6b5c' }}>LLM 编排跑在后端 · 模型 Key 不下发浏览器</span>
        <button className="btn btn-ghost" onClick={() => { void loadHealth(); void loadSessions(); }}>
          <RefreshCw size={13} /> 刷新
        </button>
      </div>

      {health && !health.ready && (
        <div className="panel mb-3" style={{ borderColor: 'rgba(250,204,21,0.35)' }}>
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} color="#facc15" />
            <span className="fs-small" style={{ color: '#facc15' }}>还没配好，缺：{health.missing.join('、')}</span>
          </div>
          <div className="fs-tiny mt-1" style={{ color: '#7d9b8a' }}>
            填进 console/.env 再重启编排服务；模型 Key 只在服务端用，不会出现在这个页面里。
          </div>
        </div>
      )}
      {health && (
        <div className="panel mb-3" style={{ borderColor: 'rgba(0,255,136,0.14)' }}>
          <div className="flex gap-4 flex-wrap fs-tiny" style={{ color: '#7d9b8a' }}>
            <span><ShieldCheck size={11} /> 后端 {health.reconlab.base_url}（{health.reconlab.key_configured ? 'key 已配' : '缺 key'}
              {health.reconlab.reachable === false ? ` · 连不上：${health.reconlab.error}` : ''}）</span>
            <span>模型 {health.llm.model} @ {health.llm.provider}（{health.llm.key_configured ? 'key 已配' : '缺 key'}）</span>
            <span>思考模式 {health.llm.thinking} · strict 回写 {health.llm.strict_writeback ? '开' : '关'}</span>
            <span>步数上限 {health.policy.max_steps} · 主动探测 {health.policy.allow_active_probe ? '开' : '关'}</span>
          </div>
        </div>
      )}

      <div className="grid gap-3" style={{ gridTemplateColumns: 'minmax(0, 220px) minmax(0, 1fr) minmax(0, 300px)' }}>
        {/* 会话 */}
        <div className="panel" style={{ alignSelf: 'start' }}>
          <div className="flex items-center justify-between mb-2">
            <span className="fs-small" style={{ color: '#b8d6c4' }}>会话</span>
            <button className="btn btn-ghost" onClick={newSession}><Plus size={13} /></button>
          </div>
          <div className="flex flex-col gap-1">
            {sessions.map((s) => (
              <button
                key={s.id}
                onClick={() => openSession(s.id)}
                className="text-left fs-tiny"
                style={{
                  padding: '0.35rem 0.4rem',
                  color: s.id === sid ? '#e8fff3' : '#7d9b8a',
                  background: s.id === sid ? 'rgba(0,255,136,0.08)' : 'transparent',
                  borderLeft: `2px solid ${s.id === sid ? '#00ff88' : 'transparent'}`,
                }}
              >
                {s.title}
                <span className="font-mono" style={{ color: '#3b5548' }}> · {s.status}</span>
              </button>
            ))}
            {!sessions.length && <span className="fs-tiny" style={{ color: '#4e6b5c' }}>还没有会话，点 + 开一个</span>}
          </div>
        </div>

        {/* 时间线 */}
        <div className="panel flex flex-col" style={{ minHeight: 420 }}>
          <div className="flex-1 flex flex-col gap-2 overflow-y-auto" style={{ maxHeight: 520 }}>
            {!sid && <span className="fs-small" style={{ color: '#4e6b5c' }}>左边开一个会话再说话。</span>}
            {merged.map((row) => (
              row.kind === 'msg' ? (
                <div key={row.key} className="flex justify-end">
                  <div className="panel" style={{ maxWidth: '80%', borderColor: 'rgba(56,189,248,0.3)' }}>
                    <div className="fs-tiny" style={{ color: '#38bdf8' }}>操作员</div>
                    <div className="fs-small" style={{ color: '#e8fff3', whiteSpace: 'pre-wrap' }}>{row.msg.content}</div>
                  </div>
                </div>
              ) : (
                <EventCard key={row.key} ev={row.ev as Ev} />
              )
            ))}
            <div ref={bottomRef} />
          </div>

          <div className="flex gap-2 mt-3">
            <textarea
              className="input flex-1"
              rows={2}
              placeholder="说人话就行：『把队列里那条开放重定向判掉』『看看现在有多少待验证』『这条证据不够，先别确认』"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
              }}
            />
            <div className="flex flex-col gap-1">
              <button className="btn btn-primary" onClick={send} disabled={running || !text.trim()}>
                <Send size={13} /> 发送
              </button>
              <button className="btn btn-ghost" onClick={stop} disabled={!running}>
                <Square size={13} /> 叫停
              </button>
            </div>
          </div>
        </div>

        {/* 状态机 */}
        <div className="panel" style={{ alignSelf: 'start' }}>
          <div className="flex items-center gap-2 mb-2">
            <ListTree size={13} color="#00ff88" />
            <span className="fs-small" style={{ color: '#b8d6c4' }}>kill-chain 台账</span>
          </div>
          <StageRail snap={lastSnapshot} />
          {!Object.keys(lastSnapshot).length && (
            <span className="fs-tiny" style={{ color: '#4e6b5c' }}>还没动过记录。</span>
          )}
        </div>
      </div>
    </div>
  );
}
