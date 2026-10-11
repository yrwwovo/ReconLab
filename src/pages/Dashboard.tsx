import { useEffect, useMemo, useState } from 'react';
import {
  Crosshair, ScanLine, Server, ShieldAlert, Cpu, Radar, ArrowRight, Wifi, WifiOff, Activity, CircleDot,
  GitBranch, Fingerprint, Plug, TrendingUp,
} from 'lucide-react';
import {
  allRecords, listRecords,
  type Finding, type Scan, type Severity, type Target, type Worker,
  type ReviewItem, type FpFingerprint, type RuleStat,
} from '../lib/api';
import { navigate } from '../lib/router';
import {
  EmptyState, SEVERITY_META, SeverityBadge, Spinner, StatCard, StatusChip, fmtRelative,
  ConfidenceMeter, ReviewStateChip, TierBadge,
} from '../components/kit';
import { splitForReport, ruleStateFor, computePrecision } from '../lib/review';

const KILL_CHAIN = ['侦察', '武器化', '投递', '利用', '驻留', '横向', '回传'] as const;

const KIND_LABEL: Record<string, string> = {
  subdomain: '子域枚举', port: '端口扫描', http: '指纹探测', dir: '目录爆破', vuln: '漏洞扫描', poc: 'POC 验证',
};

export function DashboardPage() {
  const [loading, setLoading] = useState(true);
  const [targets, setTargets] = useState<Target[]>([]);
  const [scans, setScans] = useState<Scan[]>([]);
  const [scanTotal, setScanTotal] = useState(0);
  const [assetsTotal, setAssetsTotal] = useState(0);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [queue, setQueue] = useState<ReviewItem[]>([]);
  const [fps, setFps] = useState<FpFingerprint[]>([]);
  const [ruleStats, setRuleStats] = useState<RuleStat[]>([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [tRes, sRes, aRes, fRes, wRes, qRes, fpRes, rsRes] = await Promise.all([
          listRecords<Target>('targets', { perPage: 100, fields: 'id,name,value,scope,kind,tags,created' }),
          listRecords<Scan>('scans', { perPage: 8, sort: '-created', fields: 'id,name,kind,status,progress,target,message,created,finished' }),
          listRecords<unknown>('assets', { perPage: 1, fields: 'id' }),
          allRecords<Finding>('findings', { perPage: 100, fields: 'id,title,severity,status,url,created' }, 300),
          allRecords<Worker>('workers', { sort: '-last_seen', perPage: 20 }, 20),
          allRecords<ReviewItem>('review_queue', { sort: '-created', perPage: 200 }, 400).catch(() => [] as ReviewItem[]),
          allRecords<FpFingerprint>('fp_fingerprints', { sort: '-hits', perPage: 200 }, 400).catch(() => [] as FpFingerprint[]),
          allRecords<RuleStat>('rule_stats', { sort: '-hits', perPage: 200 }, 400).catch(() => [] as RuleStat[]),
        ]);
        if (!alive) return;
        setTargets(tRes.items);
        setScans(sRes.items);
        setScanTotal(sRes.totalItems);
        setAssetsTotal(aRes.totalItems);
        setFindings(fRes);
        setWorkers(wRes);
        setQueue(qRes);
        setFps(fpRes);
        setRuleStats(rsRes);
      } catch {
        /* 静默 */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const sevCount = useMemo(() => {
    const base: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const f of findings) base[f.severity] = (base[f.severity] || 0) + 1;
    return base;
  }, [findings]);

  const running = scans.filter((s) => s.status === 'running' || s.status === 'queued').length;
  const activeWorker = workers.find((w) => w.status === 'online' || w.status === 'idle');

  if (loading) return <Spinner label="正在同步作战台数据…" />;

  return (
    <div className="section-wrap">
      <div className="container-fluid flex flex-col" style={{ gap: 'var(--gap-fluid)' }}>
        {/* 统计 */}
        <div className="grid-auto" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(190px,100%), 1fr))' }}>
          <StatCard label="授权目标" value={targets.length} icon={<Crosshair size={18} />} hint={`在范围 ${targets.filter((t) => t.scope === 'in').length} 个`} />
          <StatCard label="任务总数" value={scanTotal} icon={<ScanLine size={18} />} hint={running ? `${running} 个在跑` : '当前空闲'} tone="plain" />
          <StatCard label="资产条目" value={assetsTotal} icon={<Server size={18} />} hint="主机 / 端口 / 服务" tone="plain" />
          <StatCard
            label="命中记录"
            value={queue.length || findings.length}
            icon={<ShieldAlert size={18} />}
            hint={queue.length ? `已确认 ${queue.filter((q) => q.state === 'confirmed').length} · 待复核 ${queue.filter((q) => q.state !== 'confirmed' && q.state !== 'rejected').length}` : '全部状态合计'}
            tone={sevCount.critical > 0 ? 'danger' : 'primary'}
          />
        </div>

        {/* kill-chain 阶段条 */}
        <div className="hud-panel" style={{ padding: '0.85rem' }}>
          <div className="cmd-label mb-2">kill-chain · 当前作战阶段</div>
          <div className="flex gap-1 overflow-x-auto no-scrollbar pb-1">
            {KILL_CHAIN.map((stage, i) => {
              const reached = scanTotal > 0 && i <= (queue.length ? 3 : assetsTotal > 0 ? 2 : 1);
              const hot = reached && i === (queue.length ? 3 : assetsTotal > 0 ? 2 : 1);
              return (
                <div key={stage} className={`killstage ${hot ? 'killstage-hot' : reached ? 'killstage-hot opacity-70' : ''}`}>
                  {String(i + 1).padStart(2, '0')} {stage}
                </div>
              );
            })}
          </div>
          <div className="fs-tiny mt-2" style={{ color: '#4e6b5c' }}>
            阶段按当前台账推算：有目标 → 已侦察 → 已测绘 → 有命中进复核；未授权的越界目标会被范围守卫直接拦下
          </div>
          <div className="fs-tiny mt-1" style={{ color: '#4e6b5c' }}>
            复核口径：命中 {queue.length} 条 → 主文 {splitForReport(queue).stats.confirmed} 条 / 附录 {splitForReport(queue).stats.suspect} 条 / 疑似 {splitForReport(queue).stats.noise} 条
            {ruleStats.length > 0 && ` · 最烂规则 ${ruleStats.slice().sort((a, b) => (a.precision || 0) - (b.precision || 0))[0]?.rule_id} 精度 ${computePrecision(ruleStats.slice().sort((a, b) => (a.precision || 0) - (b.precision || 0))[0]?.hits || 0, ruleStats.slice().sort((a, b) => (a.precision || 0) - (b.precision || 0))[0]?.confirmed || 0)}%，拟定处置 ${ruleStateFor(ruleStats.slice().sort((a, b) => (a.precision || 0) - (b.precision || 0))[0]?.hits || 0, ruleStats.slice().sort((a, b) => (a.precision || 0) - (b.precision || 0))[0]?.precision || 0)}`}
          </div>
        </div>

        {/* 复核管线概览 */}
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px,100%), 1fr))', gap: 'var(--gap-fluid)' }}>
          {[
            { label: '待人工复核', value: queue.filter((q) => q.state === 'awaiting_human' || q.state === 'auto_verified').length, color: '#ffb000', to: '/review', icon: <GitBranch size={16} /> },
            { label: '误报指纹', value: fps.length, color: '#ff2b3d', to: '/fingerprints', icon: <Fingerprint size={16} /> },
            { label: '规则精度均値', value: `${ruleStats.length ? Math.round(ruleStats.reduce((a, r) => a + (r.precision || 0), 0) / ruleStats.length) : 0}%`, color: '#38d9ff', to: '/fingerprints', icon: <TrendingUp size={16} /> },
            { label: '待接任务(Agent)', value: queue.filter((q) => q.state === 'awaiting_human' || q.state === 'auto_verified' || q.state === 'retest').length, color: '#00ff88', to: '/agent', icon: <Plug size={16} /> },
          ].map((c) => (
            <button key={c.label} className="hud-panel hud-panel-hover text-left" style={{ padding: '0.8rem 0.9rem' }} onClick={() => navigate(c.to)}>
              <div className="flex items-center justify-between gap-2">
                <span className="cmd-label">{c.label}</span>
                <span style={{ color: c.color }}>{c.icon}</span>
              </div>
              <div className="fs-stat font-mono" style={{ color: c.color }}>{c.value}</div>
            </button>
          ))}
        </div>

        {queue.length > 0 && (
          <div className="hud-panel overflow-hidden">
            <div className="panel-head">
              <GitBranch size={13} />复核管线 · 最近入队
              <button className="ml-auto fs-tiny" style={{ color: '#00ff88', textTransform: 'none', letterSpacing: 0 }} onClick={() => navigate('/review')}>
                进复核台 →
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="data-table" style={{ minWidth: 620 }}>
                <thead>
                  <tr><th>规则</th><th>标题</th><th>置信度</th><th>状态</th><th>分档</th></tr>
                </thead>
                <tbody>
                  {queue.slice(0, 6).map((q) => (
                    <tr key={q.id} style={{ cursor: 'pointer' }} onClick={() => navigate('/review')}>
                      <td className="font-mono fs-tiny" style={{ color: '#00ff88' }}>{q.rule_id || '—'}</td>
                      <td className="truncate" style={{ maxWidth: 260, color: '#e8fff3' }}>{q.title}</td>
                      <td><ConfidenceMeter score={q.confidence} tier={q.tier} /></td>
                      <td><ReviewStateChip state={q.state} /></td>
                      <td><TierBadge tier={q.tier} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="grid gap-3 lg:grid-cols-[1.55fr_1fr]" style={{ gap: 'var(--gap-fluid)' }}>
          {/* 最近任务 */}
          <div className="hud-panel min-w-0">
            <div className="panel-head">
              <Activity size={13} style={{ color: '#00ff88' }} />
              <span>最近任务</span>
              <button className="ml-auto fs-tiny" style={{ color: '#00ff88', textTransform: 'none', letterSpacing: 0 }} onClick={() => navigate('/scans')}>
                全部任务 →
              </button>
            </div>
            {scans.length === 0 ? (
              <EmptyState
                icon={<ScanLine size={30} />}
                title="还没有任务"
                desc="先在「授权目标」里登记允许测试的资产,再到「任务编排」下发第一条侦察任务。"
              />
            ) : (
              <div className="flex flex-col">
                {scans.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => navigate(`/scans/${s.id}`)}
                    className="flex items-center gap-3 px-3 py-2.5 text-left transition-colors"
                    style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="fs-small truncate font-medium" style={{ color: '#e8fff3' }}>{s.name || KIND_LABEL[s.kind]}</span>
                        <span className="chip shrink-0">{KIND_LABEL[s.kind] || s.kind}</span>
                      </div>
                      <div className="fs-tiny mt-0.5 truncate" style={{ color: '#4e6b5c' }}>
                        {s.message || fmtRelative(s.created)}
                      </div>
                    </div>
                    <StatusChip status={s.status} />
                    <ArrowRight size={14} style={{ color: '#2c4739', flexShrink: 0 }} />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 严重度分布 + 执行器 */}
          <div className="flex flex-col" style={{ gap: 'var(--gap-fluid)' }}>
            <div className="hud-panel">
              <div className="panel-head"><ShieldAlert size={13} style={{ color: '#ffb000' }} /><span>严重度分布</span></div>
              <div className="p-3 flex flex-col gap-2.5">
                {(Object.keys(SEVERITY_META) as Severity[]).map((sev) => {
                  const count = sevCount[sev] || 0;
                  const pct = findings.length ? Math.round((count / findings.length) * 100) : 0;
                  const meta = SEVERITY_META[sev];
                  return (
                    <div key={sev} className="flex items-center gap-2.5">
                      <span className="fs-tiny shrink-0" style={{ color: meta.color, width: 32 }}>{meta.label}</span>
                      <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)', minWidth: 0 }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: meta.color, transition: 'width .5s ease' }} />
                      </div>
                      <span className="fs-tiny font-mono shrink-0" style={{ color: '#7d9b8a', width: 28, textAlign: 'right' }}>{count}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="hud-panel">
              <div className="panel-head">
                <Cpu size={13} style={{ color: '#38d9ff' }} /><span>执行器</span>
                <button className="ml-auto fs-tiny" style={{ color: '#00ff88', textTransform: 'none', letterSpacing: 0 }} onClick={() => navigate('/workers')}>接入 →</button>
              </div>
              <div className="p-3">
                {activeWorker ? (
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      <Wifi size={14} style={{ color: '#00ff88' }} />
                      <span className="fs-small" style={{ color: '#e8fff3' }}>{activeWorker.name || '执行器'}</span>
                      <span className="chip ml-auto" style={{ color: '#00ff88' }}>在线</span>
                    </div>
                    <div className="fs-tiny font-mono" style={{ color: '#4e6b5c' }}>
                      {activeWorker.hostname || '—'} · {activeWorker.os || '—'}
                    </div>
                    <div className="fs-tiny" style={{ color: '#4e6b5c' }}>心跳 {fmtRelative(activeWorker.last_seen)}</div>
                    {activeWorker.caps && <div className="fs-tiny" style={{ color: '#38d9ff' }}>能力: {activeWorker.caps}</div>}
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <WifiOff size={14} style={{ color: '#ff6b3d' }} />
                      <span className="fs-small" style={{ color: '#e8fff3' }}>没有执行器在线</span>
                    </div>
                    <p className="fs-tiny" style={{ color: '#4e6b5c' }}>
                      控制台只负责编排,实际扫描由你本机跑的执行器完成。到「执行器」页按提示接入即可。
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* 最新发现 */}
        <div className="hud-panel min-w-0">
          <div className="panel-head">
            <CircleDot size={13} style={{ color: '#ff2d55' }} /><span>最新发现</span>
            <button className="ml-auto fs-tiny" style={{ color: '#00ff88', textTransform: 'none', letterSpacing: 0 }} onClick={() => navigate('/findings')}>全部 →</button>
          </div>
          {findings.length === 0 ? (
            <EmptyState icon={<Radar size={30} />} title="还没有发现" desc="跑完一轮漏洞扫描或 POC 验证后,结果会汇到这里。" />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table" style={{ minWidth: 520 }}>
                <thead><tr><th>等级</th><th>标题</th><th className="hidden sm:table-cell">目标</th><th>状态</th><th className="hidden md:table-cell">时间</th></tr></thead>
                <tbody>
                  {[...findings]
                    .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime())
                    .slice(0, 8)
                    .map((f) => (
                      <tr key={f.id} onClick={() => navigate('/findings')} style={{ cursor: 'pointer' }}>
                        <td><SeverityBadge severity={f.severity} /></td>
                        <td className="truncate" style={{ maxWidth: 260 }}>{f.title}</td>
                        <td className="hidden sm:table-cell fs-tiny font-mono truncate" style={{ color: '#7d9b8a', maxWidth: 200 }}>{f.url || '—'}</td>
                        <td><span className="chip">{f.status === 'confirmed' ? '已确认' : f.status === 'false_positive' ? '误报' : f.status === 'fixed' ? '已修复' : '待验证'}</span></td>
                        <td className="hidden md:table-cell fs-tiny" style={{ color: '#4e6b5c' }}>{fmtRelative(f.created)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
