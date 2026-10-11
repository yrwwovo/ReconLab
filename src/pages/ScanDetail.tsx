import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, RotateCw, XOctagon, Terminal, Server, ShieldAlert, Cpu, Clock, Trash2 } from 'lucide-react';
import { allRecords, api, deleteRecord, updateRecord, type Asset, type Finding, type Scan, type Target } from '../lib/api';
import { navigate } from '../lib/router';
import { EmptyState, SeverityBadge, Spinner, StatusChip, fmtTime, notify } from '../components/kit';
import { KIND_META } from './Scans';

function StatRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <span className="fs-tiny" style={{ color: '#5d6b7d' }}>{label}</span>
      <span className="fs-small font-mono truncate" style={{ color: '#c9d4e0' }}>{value}</span>
    </div>
  );
}

export function ScanDetailPage({ id }: { id: string }) {
  const [scan, setScan] = useState<Scan | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(true);
  const logBox = useRef<HTMLDivElement | null>(null);

  const loadScan = async () => {
    const rec = await api<Scan>(`/collections/scans/records/${id}`);
    setScan(rec);
    return rec;
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const rec = await loadScan();
        if (!alive) return;
        const [tgt, aList, fList] = await Promise.all([
          rec.target ? api<Target>(`/collections/targets/records/${rec.target}`).catch(() => null) : Promise.resolve(null),
          allRecords<Asset>('assets', { filter: `scan="${rec.id}"`, perPage: 100 }, 300),
          allRecords<Finding>('findings', { filter: `scan="${rec.id}"`, perPage: 100 }, 300),
        ]);
        if (!alive) return;
        setTarget(tgt);
        setAssets(aList);
        setFindings(fList);
      } catch (e) {
        notify(e instanceof Error ? e.message : '加载失败', 'err');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [id]);

  useEffect(() => {
    if (!scan || (scan.status !== 'running' && scan.status !== 'queued')) return;
    const t = window.setInterval(() => {
      void loadScan().catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(t);
  }, [scan]);

  useEffect(() => {
    if (logBox.current) logBox.current.scrollTop = logBox.current.scrollHeight;
  }, [scan?.log]);

  const args = useMemo(() => {
    if (!scan?.args) return {};
    try { return typeof scan.args === 'string' ? JSON.parse(scan.args) : scan.args; } catch { return {}; }
  }, [scan?.args]);

  const stats = useMemo(() => {
    if (!scan?.stats) return {};
    try { return typeof scan.stats === 'string' ? JSON.parse(scan.stats) : scan.stats; } catch { return {}; }
  }, [scan?.stats]);

  if (loading) return <Spinner label="正在读取任务详情…" />;
  if (!scan) {
    return (
      <div className="section-wrap"><div className="container-fluid">
        <div className="hud-panel"><EmptyState icon={<Terminal size={30} />} title="任务不存在" desc="可能已经被删掉了。" action={<button className="btn btn-primary mt-2" onClick={() => navigate('/scans')}>返回任务列表</button>} /></div>
      </div></div>
    );
  }

  const meta = KIND_META[scan.kind];
  const active = scan.status === 'running' || scan.status === 'queued';

  return (
    <div className="section-wrap">
      <div className="container-fluid flex flex-col" style={{ gap: 'var(--gap-fluid)' }}>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-ghost !py-1.5" onClick={() => navigate('/scans')}><ArrowLeft size={14} />返回</button>
          <span className="chip">{meta?.label || scan.kind}</span>
          <StatusChip status={scan.status} />
          <div className="flex-1" />
          {active ? (
            <button className="btn btn-danger !py-1.5" onClick={async () => { await updateRecord('scans', scan.id, { status: 'canceled', message: '已手动终止' }); await loadScan(); notify('已终止', 'ok'); }}>
              <XOctagon size={14} />终止任务
            </button>
          ) : (
            <button className="btn btn-ghost !py-1.5" onClick={async () => { await updateRecord('scans', scan.id, { status: 'queued', progress: 0, message: '重新排队', log: '', finished: null, worker: null }); await loadScan(); notify('已重新排队', 'ok'); }}>
              <RotateCw size={14} />重新执行
            </button>
          )}
          <button className="btn btn-danger !py-1.5 !px-2.5" onClick={async () => { await deleteRecord('scans', scan.id); notify('任务已删除', 'ok'); navigate('/scans'); }}>
            <Trash2 size={14} />
          </button>
        </div>

        <div>
          <h2 className="fs-heading" style={{ color: '#eaf1f8' }}>{scan.name || meta?.label}</h2>
          <div className="fs-tiny mt-1" style={{ color: '#5d6b7d' }}>{scan.message || '—'}</div>
        </div>

        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
          <div style={{ width: `${Math.min(100, Math.max(0, scan.progress || 0))}%`, height: '100%', background: scan.status === 'failed' ? '#ff2d55' : 'linear-gradient(90deg,#0d5c46,#22e3a0)', transition: 'width .4s ease' }} />
        </div>

        <div className="grid gap-3 lg:grid-cols-[1fr_320px]" style={{ gap: 'var(--gap-fluid)' }}>
          <div className="flex flex-col min-w-0" style={{ gap: 'var(--gap-fluid)' }}>
            <div className="hud-panel min-w-0">
              <div className="panel-head"><Terminal size={13} style={{ color: '#22e3a0' }} /><span>执行日志</span>
                {active && <span className="ml-auto fs-tiny cursor-blink" style={{ color: '#22e3a0', textTransform: 'none', letterSpacing: 0 }}>live</span>}
              </div>
              <div ref={logBox} className="terminal m-3" style={{ height: 'min(46vh, 420px)' }}>
                {scan.log || (scan.status === 'queued' ? '[ 等待执行器领取任务… ]' : '[ 暂无日志 ]')}
              </div>
            </div>

            <div className="hud-panel min-w-0">
              <div className="panel-head"><Server size={13} style={{ color: '#4cc9f0' }} /><span>本次产出资产</span><span className="ml-auto fs-tiny" style={{ color: '#5d6b7d', textTransform: 'none' }}>{assets.length}</span></div>
              {assets.length === 0 ? (
                <EmptyState icon={<Server size={26} />} title="暂无资产" desc="任务跑完后,发现的主机 / 端口 / 服务会列在这里。" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="data-table" style={{ minWidth: 460 }}>
                    <thead><tr><th>主机</th><th>端口</th><th>服务</th><th className="hidden sm:table-cell">标题 / 指纹</th></tr></thead>
                    <tbody>
                      {assets.slice(0, 50).map((a) => (
                        <tr key={a.id}>
                          <td className="font-mono fs-tiny">{a.host}</td>
                          <td className="font-mono fs-tiny">{a.port || '—'}</td>
                          <td className="fs-tiny">{a.service || '—'}</td>
                          <td className="hidden sm:table-cell fs-tiny truncate" style={{ color: '#8896a8', maxWidth: 220 }}>{a.title || a.tech || a.banner || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="hud-panel min-w-0">
              <div className="panel-head"><ShieldAlert size={13} style={{ color: '#ff2d55' }} /><span>本次发现</span><span className="ml-auto fs-tiny" style={{ color: '#5d6b7d', textTransform: 'none' }}>{findings.length}</span></div>
              {findings.length === 0 ? (
                <EmptyState icon={<ShieldAlert size={26} />} title="暂无发现" desc="扫描/验证命中的问题会汇到这里,并带原始证据。" />
              ) : (
                <div className="flex flex-col">
                  {findings.map((f) => (
                    <button key={f.id} className="flex items-center gap-2.5 px-3 py-2.5 text-left" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }} onClick={() => navigate('/findings')}>
                      <SeverityBadge severity={f.severity} />
                      <span className="fs-small truncate flex-1 min-w-0" style={{ color: '#eaf1f8' }}>{f.title}</span>
                      <span className="fs-tiny font-mono truncate hidden sm:block" style={{ color: '#5d6b7d', maxWidth: 220 }}>{f.url}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col" style={{ gap: 'var(--gap-fluid)' }}>
            <div className="hud-panel">
              <div className="panel-head"><Cpu size={13} style={{ color: '#ffb020' }} /><span>任务信息</span></div>
              <div className="px-3 py-2">
                <StatRow label="目标" value={target ? (target.name || target.value) : '—'} />
                <StatRow label="目标值" value={target?.value || '—'} />
                <StatRow label="类型" value={meta?.label || scan.kind} />
                <StatRow label="并发" value={String(args.concurrency ?? '—')} />
                <StatRow label="超时" value={`${args.timeout ?? '—'}s`} />
                {args.dict !== undefined && <StatRow label="字典" value={String(args.dict)} />}
                {args.ports !== undefined && <StatRow label="端口" value={String(args.ports)} />}
                {Array.isArray(args.checks) && <StatRow label="检测项" value={`${(args.checks as string[]).length} 项`} />}
                <StatRow label="外部工具" value={args.use_external ? '优先调用' : '仅内置引擎'} />
                <StatRow label="安全模式" value={args.safe_mode ? '开' : '关'} />
                <StatRow label="创建" value={fmtTime(scan.created)} />
                <StatRow label="开始" value={fmtTime(scan.started)} />
                <StatRow label="结束" value={fmtTime(scan.finished)} />
              </div>
            </div>

            {Object.keys(stats).length > 0 && (
              <div className="hud-panel">
                <div className="panel-head"><Clock size={13} style={{ color: '#4cc9f0' }} /><span>统计</span></div>
                <div className="px-3 py-2">
                  {Object.entries(stats as Record<string, unknown>).map(([k, v]) => (
                    <StatRow key={k} label={k} value={String(v)} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
