import { useCallback, useEffect, useState } from 'react';
import { Bot, ShieldCheck, Square, Plus } from 'lucide-react';

type Event = { seq: number; kind: string; payload: { text?: string; message?: string; summary?: string; name?: string; code?: string }; created: number };
type Row = { id: string; url: string; status: string; updated: number };
type Artifacts = { report: string; evidence: { evidence_id: string; http_status: number; sha256: string }[] };
type Session = Row & { text: string; approval_id: string; approval_expires: number; task_id?: string;
  events: Event[]; result?: Artifacts & { summary: string }; artifacts?: Artifacts };
type Health = { ready: boolean; runtime: string; mode: string };
const labels: Record<string, string> = { awaiting_approval: '等待授权', preparing: '准备中',
  running: '执行中', done: '已完成', error: '执行失败', cancelled: '已停止', interrupted: '已中断' };
const active = new Set(['preparing', 'running']);
const panel = { border: '1px solid rgba(192,132,252,.24)', background: 'rgba(192,132,252,.035)', padding: '1rem' };
const field = { width: '100%', background: '#07100e', border: '1px solid #375044', color: '#dceee4', padding: '.7rem' };
const button = { border: '1px solid #77519d', padding: '.5rem .9rem', color: '#ddc3ff', background: '#241a30', cursor: 'pointer' };

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch('/phantomveil' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 ${response.status}`);
  return data;
}

export function ConsolePage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [selected, setSelected] = useState('');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('只读观察这个页面，清点链接和静态 GET 表单入口，并给出证据报告。');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const artifacts = session?.result || session?.artifacts;
  const refresh = useCallback(async () => {
    const [h, list] = await Promise.all([request<Health>('/health'), request<{ sessions: Row[] }>('/sessions')]);
    setHealth(h); setRows(list.sessions);
  }, []);
  useEffect(() => {
    let alive = true;
    const poll = async () => { try { if (alive) await refresh(); }
      catch { if (alive) { setHealth(null); setError('PhantomVeil 服务未连接。请启动本机连接服务。'); } } };
    void poll(); const timer = setInterval(() => void poll(), 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [refresh]);
  useEffect(() => {
    if (!selected) { setSession(null); return; }
    let alive = true;
    const poll = async () => { try {
      const data = await request<{ session: Session }>(`/sessions/${selected}`);
      if (alive) setSession(data.session);
    } catch (e) { if (alive) setError(e instanceof Error ? e.message : '读取任务失败'); } };
    void poll(); const timer = setInterval(() => void poll(), 750);
    return () => { alive = false; clearInterval(timer); };
  }, [selected]);
  async function action(operation: () => Promise<void>) {
    setBusy(true); setError('');
    try { await operation(); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : '操作失败'); }
    finally { setBusy(false); }
  }
  function approve(approved: boolean) {
    if (!session) return;
    void action(async () => {
      const data = await request<{ session: Session }>(`/sessions/${session.id}/approve`,
        { approval_id: session.approval_id, approved });
      setSession(data.session);
    });
  }
  return <div className="flex flex-col gap-4">
    <header className="flex items-center justify-between gap-3 flex-wrap">
      <div><h1 className="text-xl font-semibold flex items-center gap-2"><Bot /> PhantomVeil 作战台</h1>
        <p className="text-sm mt-2" style={{ color: '#b4a5c8' }}>ReconLab 下达任务 · PhantomVeil 执行 · Hermes 驱动</p></div>
      <span role="status" style={{ color: health?.ready ? '#c084fc' : '#facc15' }}>
        {health?.ready ? '本机运行入口已连接' : '等待 PhantomVeil 连接'}</span>
    </header>
    <p className="text-sm" style={{ color: '#9baea3' }}>当前可执行：一次只读 GET 观察、证据保存和离线入口清点。模型配置沿用服务端 Hermes 设置。</p>
    {error && <div role="alert" style={{ ...panel, color: '#ffafaf' }}>{error}</div>}
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(180px,1fr)_minmax(0,4fr)] gap-4">
      <aside style={panel}>
        <button style={button} onClick={() => { setSelected(''); setError(''); }}><Plus size={14} className="inline" /> 新任务</button>
        <div className="flex flex-col gap-2 mt-4">{rows.map(row => <button key={row.id}
          onClick={() => { setSession(null); setSelected(row.id); }}
          style={{ textAlign: 'left', padding: '.6rem', border: selected === row.id ? '1px solid #a970db' : '1px solid #293b32', overflowWrap: 'anywhere' }}>
          <div className="text-sm">{row.url}</div><small style={{ color: '#b4a5c8' }}>{labels[row.status] || row.status}</small>
        </button>)}</div>
      </aside>
      <main className="flex flex-col gap-4" style={{ minWidth: 0 }}>
        {!selected && <form style={panel} className="flex flex-col gap-3" onSubmit={e => {
          e.preventDefault(); void action(async () => {
            const data = await request<{ session: Session }>('/sessions', { url, text });
            setSession(data.session); setSelected(data.session.id);
          });
        }}>
          <label>授权目标 URL<input required type="url" placeholder="https://example.com/" value={url}
            onChange={e => setUrl(e.target.value)} style={field} /></label>
          <label>任务<textarea required maxLength={4000} rows={4} value={text}
            onChange={e => setText(e.target.value)} style={field} /></label>
          <p className="text-sm" style={{ color: '#9baea3' }}>提交后将展示精确目标与操作范围，等待你确认授权。</p>
          <button disabled={busy || !health?.ready} style={button}>提交任务</button>
        </form>}
        {selected && !session && <div style={panel}>读取任务…</div>}
        {session && <>
          <section style={panel}>
            <div className="flex items-center justify-between gap-2"><strong>{labels[session.status] || session.status}</strong>
              {active.has(session.status) && <button disabled={busy} style={button} onClick={() => void action(async () => {
                const data = await request<{ session: Session }>(`/sessions/${session.id}/cancel`, {}); setSession(data.session);
              })}><Square size={13} className="inline" /> 叫停</button>}</div>
            <p style={{ overflowWrap: 'anywhere', marginTop: '.8rem' }}>{session.url}</p>
            <p style={{ whiteSpace: 'pre-wrap', marginTop: '.5rem' }}>{session.text}</p>
            {session.task_id && <small style={{ color: '#9baea3' }}>PV 任务：{session.task_id}</small>}
          </section>
          {session.status === 'awaiting_approval' && <section style={panel}>
            <h2 className="flex items-center gap-2"><ShieldCheck size={18} /> 确认目标授权</h2>
            <p className="text-sm my-3">批准即确认你有权测试上述 URL。本次仅允许对该精确 URL 发出一次只读 GET，并离线分析产生的证据。批准有效期十分钟。</p>
            <div className="flex gap-3"><button style={button} disabled={busy} onClick={() => approve(true)}>确认授权并执行</button>
              <button style={button} disabled={busy} onClick={() => approve(false)}>拒绝</button></div>
          </section>}
          <section style={panel}><h2>执行记录</h2><div className="flex flex-col gap-3 mt-3">
            {session.events.filter(event => ['status', 'tool', 'assistant', 'error', 'done'].includes(event.kind)).map(event =>
              <div key={event.seq} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: event.kind === 'error' ? '#ffafaf' : '#d0dcd5' }}>
                <small style={{ color: '#8a9c91' }}>{new Date(event.created * 1000).toLocaleTimeString()}　</small>
                {event.payload.text || event.payload.message || event.payload.summary || `${event.payload.name}：${event.payload.code}`}
              </div>)}
          </div></section>
          {artifacts && <section style={panel}><h2>证据与报告</h2>
            {artifacts.evidence.map(ev => <div key={ev.evidence_id} className="text-sm my-3" style={{ overflowWrap: 'anywhere' }}>
              <strong>{ev.evidence_id}</strong> · HTTP {ev.http_status}<br /><small>SHA-256：{ev.sha256}</small>
            </div>)}
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'inherit', fontSize: '.875rem' }}>{artifacts.report}</pre>
          </section>}
        </>}
      </main>
    </div>
  </div>;
}
