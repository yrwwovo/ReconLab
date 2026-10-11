import { useEffect, useMemo, useState } from 'react';
import { ShieldAlert, Search, Download, Check, X, Wrench, Trash2, ExternalLink, GitBranch, Layers } from 'lucide-react';
import {
  allRecords, createRecord, deleteRecord, updateRecord,
  type Finding, type FindingStatus, type Severity, type Target, type ReviewItem,
} from '../lib/api';
import {
  ConfidenceMeter, CopyButton, EmptyState, FindingStatusChip, Kv, Modal, OriginChip,
  ReviewStateChip, SEVERITY_META, Select, SeverityBadge, Spinner, TextInput, TierBadge, fmtTime, notify,
} from '../components/kit';
import { buildCurl, computeConfidence, dedupKey, profileResponse, tierOfScore, type CheckResult } from '../lib/review';

function Block({ title, content }: { title: string; content?: string }) {
  if (!content) return null;
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="field-label !mb-0">{title}</span>
        <CopyButton text={content} />
      </div>
      <div className="terminal" style={{ maxHeight: 220 }}>{content}</div>
    </div>
  );
}

export function FindingsPage() {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<Finding[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [q, setQ] = useState('');
  const [sev, setSev] = useState('');
  const [status, setStatus] = useState('');
  const [detail, setDetail] = useState<Finding | null>(null);
  const [queue, setQueue] = useState<ReviewItem[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [fList, tList, qList] = await Promise.all([
          allRecords<Finding>('findings', { sort: '-created', perPage: 100 }, 600),
          allRecords<Target>('targets', { perPage: 100, fields: 'id,name,value' }, 300),
          allRecords<ReviewItem>('review_queue', { sort: '-created', perPage: 200 }, 600).catch(() => [] as ReviewItem[]),
        ]);
        if (!alive) return;
        setItems(fList);
        setTargets(tList);
        setQueue(qList);
      } catch (e) {
        notify(e instanceof Error ? e.message : '加载失败', 'err');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const targetMap = useMemo(() => new Map(targets.map((t) => [t.id, t])), [targets]);
  const queueByFinding = useMemo(() => {
    const map = new Map<string, ReviewItem>();
    for (const q of queue) if (q.finding) map.set(q.finding, q);
    return map;
  }, [queue]);

  /** 把一条发现送进复核流水线：算一次初判置信度 + 生成可复现命令，状态落 new 等降噪 */
  const enqueue = async (f: Finding) => {
    setBusyId(f.id);
    try {
      const raw: CheckResult[] = [];
      const prof = profileResponse(f.response);
      const conf = computeConfidence({ checks: raw, severity: f.severity, sources: 1 });
      const created = await createRecord<ReviewItem>('review_queue', {
        finding: f.id,
        target: f.target,
        scan: f.scan,
        rule_id: f.category || f.title,
        title: f.title,
        url: f.url,
        parameter: f.parameter,
        severity: f.severity,
        state: 'new',
        origin: 'scanner',
        confidence: conf.score,
        tier: tierOfScore(conf.score),
        dedup_hash: dedupKey({ rule_id: f.category || f.title, url: f.url, parameter: f.parameter }),
        instances: 1,
        evidence: `响应指纹 ${prof.sig} · 归一化长度 ${prof.length}`,
        raw_request: f.request,
        raw_response: f.response,
        curl: buildCurl({ url: f.url, request: f.request, payload: f.payload }),
        attempts: 1,
      });
      setQueue((prev) => [created, ...prev]);
      notify('已入队复核', 'ok');
    } catch (e) {
      notify(e instanceof Error ? e.message : '入队失败', 'err');
    } finally {
      setBusyId(null);
    }
  };

  const enqueueAll = async () => {
    const pending = filtered.filter((f) => !queueByFinding.has(f.id));
    if (!pending.length) { notify('当前的发现都已在复核队列里', 'info'); return; }
    let n = 0;
    for (const f of pending) {
      try {
        await enqueue(f);
        n += 1;
      } catch { /* 继续 */ }
    }
    notify(`已入队 ${n} 条`, 'ok');
  };

  const filtered = useMemo(() => {
    const key = q.trim().toLowerCase();
    return items.filter((f) => {
      if (sev && f.severity !== sev) return false;
      if (status && f.status !== status) return false;
      if (!key) return true;
      return [f.title, f.url, f.category, f.cve, f.evidence].filter(Boolean).some((v) => String(v).toLowerCase().includes(key));
    });
  }, [items, q, sev, status]);

  const counts = useMemo(() => {
    const base: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const f of items) base[f.severity] = (base[f.severity] || 0) + 1;
    return base;
  }, [items]);

  const setFindingStatus = async (f: Finding, next: FindingStatus) => {
    try {
      const updated = await updateRecord<Finding>('findings', f.id, { status: next });
      setItems((prev) => prev.map((x) => (x.id === f.id ? updated : x)));
      setDetail((prev) => (prev && prev.id === f.id ? updated : prev));
      notify(next === 'confirmed' ? '已确认为真实漏洞' : next === 'false_positive' ? '已标记为误报' : next === 'fixed' ? '已标记修复' : '已重置', 'ok');
    } catch (e) {
      notify(e instanceof Error ? e.message : '操作失败', 'err');
    }
  };

  const exportCsv = () => {
    const rows = filtered.map((f) => ({
      severity: SEVERITY_META[f.severity]?.label || f.severity, title: f.title, url: f.url,
      category: f.category, parameter: f.parameter, payload: f.payload, cve: f.cve,
      status: f.status, confidence: f.confidence, created: f.created,
    }));
    const heads = ['severity', 'title', 'url', 'category', 'parameter', 'payload', 'cve', 'status', 'confidence', 'created'];
    const labels = ['等级', '标题', 'URL', '分类', '参数', 'Payload', 'CVE', '状态', '置信度', '发现时间'];
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = `\uFEFF${labels.join(',')}\n${rows.map((r) => heads.map((h) => esc((r as Record<string, unknown>)[h])).join(',')).join('\n')}`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reconlab-findings-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    notify(`已导出 ${filtered.length} 条发现`, 'ok');
  };

  if (loading) return <Spinner label="正在拉取发现…" />;

  return (
    <div className="section-wrap">
      <div className="container-fluid flex flex-col" style={{ gap: 'var(--gap-fluid)' }}>
        <div className="grid-auto" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(130px,100%), 1fr))' }}>
          {(Object.keys(SEVERITY_META) as Severity[]).map((s) => (
            <button
              key={s}
              className="hud-panel hud-panel-hover p-2.5 text-left"
              onClick={() => setSev(sev === s ? '' : s)}
              style={{ borderColor: sev === s ? SEVERITY_META[s].color : undefined }}
            >
              <div className="fs-tiny" style={{ color: SEVERITY_META[s].color }}>{SEVERITY_META[s].label}</div>
              <div className="fs-stat font-mono font-bold" style={{ color: '#e8fff3' }}>{counts[s] || 0}</div>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[160px]">
            <Search size={14} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: '#37503f' }} />
            <TextInput placeholder="搜索标题 / URL / CVE…" value={q} onChange={(e) => setQ(e.target.value)} style={{ paddingLeft: 28 }} />
          </div>
          <div style={{ minWidth: 140 }}>
            <Select value={sev} onChange={(e) => setSev(e.target.value)}>
              <option value="">全部等级</option>
              {(Object.keys(SEVERITY_META) as Severity[]).map((s) => <option key={s} value={s}>{SEVERITY_META[s].label}</option>)}
            </Select>
          </div>
          <div style={{ minWidth: 140 }}>
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">全部状态</option>
              <option value="new">待验证</option>
              <option value="confirmed">已确认</option>
              <option value="false_positive">误报</option>
              <option value="fixed">已修复</option>
            </Select>
          </div>
          <button className="btn btn-ghost" onClick={() => void enqueueAll()} disabled={filtered.length === 0}>
            <GitBranch size={14} />全部送复核
          </button>
          <button className="btn btn-ghost" onClick={exportCsv} disabled={filtered.length === 0}><Download size={14} />导出 CSV</button>
        </div>

        {filtered.length === 0 ? (
          <div className="hud-panel">
            <EmptyState icon={<ShieldAlert size={30} />} title="没有发现" desc="漏洞扫描或 POC 验证命中后,结论会带证据汇到这里。" />
          </div>
        ) : (
          <div className="hud-panel overflow-hidden">
            <div className="overflow-x-auto">
              <table className="data-table" style={{ minWidth: 700 }}>
                <thead>
                  <tr>
                    <th>等级</th><th>标题</th><th className="hidden md:table-cell">位置</th>
                    <th className="hidden sm:table-cell">复核进度</th>
                    <th className="hidden lg:table-cell">时间</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, 300).map((f) => (
                    <tr key={f.id} style={{ cursor: 'pointer' }} onClick={() => setDetail(f)}>
                      <td><SeverityBadge severity={f.severity} /></td>
                      <td className="truncate" style={{ maxWidth: 260, color: '#e8fff3' }}>{f.title}</td>
                      <td className="hidden md:table-cell fs-tiny font-mono truncate" style={{ color: '#7d9b8a', maxWidth: 240 }}>{f.url || '—'}</td>
                      <td className="hidden sm:table-cell">
                        {(() => {
                          const q = queueByFinding.get(f.id);
                          if (!q) {
                            return <button
                              className="btn btn-ghost btn-sm"
                              disabled={busyId === f.id}
                              onClick={(e) => { e.stopPropagation(); void enqueue(f); }}
                            >
                              <GitBranch size={11} />{busyId === f.id ? '入队中' : '送复核'}
                            </button>;
                          }
                          return (
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <ReviewStateChip state={q.state} />
                              <TierBadge tier={q.tier} score={q.confidence} />
                            </div>
                          );
                        })()}
                      </td>
                      <td className="hidden lg:table-cell fs-tiny" style={{ color: '#4e6b5c', whiteSpace: 'nowrap' }}>{fmtTime(f.created)}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <button
                          className="btn btn-danger !py-1 !px-1.5"
                          onClick={async () => {
                            try {
                              await deleteRecord('findings', f.id);
                              setItems((prev) => prev.filter((x) => x.id !== f.id));
                              notify('已删除', 'ok');
                            } catch (e) { notify(e instanceof Error ? e.message : '删除失败', 'err'); }
                          }}
                        >
                          <Trash2 size={11} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail?.title || '发现详情'}
        wide
        footer={
          detail ? (
            <>
              {!queueByFinding.has(detail.id) && (
                <button className="btn btn-accent" disabled={busyId === detail.id} onClick={() => void enqueue(detail)}>
                  <GitBranch size={13} />送复核流水线
                </button>
              )}
              <button className="btn btn-ghost" onClick={() => setFindingStatus(detail, 'new')}>标记待验证</button>
              <button className="btn btn-danger" onClick={() => setFindingStatus(detail, 'false_positive')}><X size={13} />标记误报</button>
              <button className="btn btn-accent" onClick={() => setFindingStatus(detail, 'fixed')}><Wrench size={13} />已修复</button>
              <button className="btn btn-primary" onClick={() => setFindingStatus(detail, 'confirmed')}><Check size={13} />确认漏洞</button>
            </>
          ) : null
        }
      >
        {detail && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <SeverityBadge severity={detail.severity} />
              <FindingStatusChip status={detail.status} />
              {detail.category && <span className="chip">{detail.category}</span>}
              {detail.cve && <span className="chip" style={{ color: '#ffb000' }}>{detail.cve}</span>}
              {detail.confidence != null && (
                <span className="chip" style={{ color: '#38d9ff' }}>置信度 {Math.round(detail.confidence * 100)}%</span>
              )}
            </div>

            <div className="flex flex-col gap-1">
              {detail.url && (
                <div className="flex items-center gap-2 min-w-0">
                  <span className="field-label !mb-0 shrink-0">位置</span>
                  <a href={detail.url} target="_blank" rel="noreferrer" className="fs-small font-mono truncate" style={{ color: '#38d9ff' }}>
                    {detail.url} <ExternalLink size={11} style={{ display: 'inline' }} />
                  </a>
                </div>
              )}
              {detail.parameter && <div className="fs-small"><span className="field-label !mb-0">参数:</span> <span className="font-mono">{detail.parameter}</span></div>}
              {detail.payload && <div className="fs-small"><span className="field-label !mb-0">Payload:</span> <span className="font-mono" style={{ color: '#ffb000' }}>{detail.payload}</span></div>}
              <div className="fs-small">
                <span className="field-label !mb-0">所属目标:</span>{' '}
                <span className="font-mono">{detail.target ? (targetMap.get(detail.target)?.name || targetMap.get(detail.target)?.value || '—') : '—'}</span>
              </div>
              <div className="fs-tiny" style={{ color: '#4e6b5c' }}>发现时间 {fmtTime(detail.created)}{detail.updated ? ` · 最近更新 ${fmtTime(detail.updated)}` : ''}</div>
            </div>

            {(() => {
              const q = queueByFinding.get(detail.id);
              if (!q) return null;
              return (
                <div className="hud-panel" style={{ padding: '0.75rem 0.9rem' }}>
                  <div className="cmd-label mb-1 flex items-center gap-2"><Layers size={12} />复核台账</div>
                  <div className="flex items-center gap-2 flex-wrap mb-2">
                    <ReviewStateChip state={q.state} />
                    <TierBadge tier={q.tier} score={q.confidence} />
                    <OriginChip origin={q.origin} agent={q.agent_name} />
                    <ConfidenceMeter score={q.confidence} tier={q.tier} />
                  </div>
                  <Kv k="规则" v={q.rule_id || '—'} />
                  <Kv k="指纹" v={q.dedup_hash || '—'} />
                  <Kv k="实例" v={`x${q.instances ?? 1}`} />
                  {q.verdict_note && <Kv k="判定" v={q.verdict_note} />}
                  {q.curl && <Kv k="复现" v={q.curl} />}
                </div>
              );
            })()}

            {detail.evidence && (
              <div className="p-3 rounded" style={{ background: 'rgba(34,227,160,0.05)', border: '1px solid rgba(34,227,160,0.2)' }}>
                <div className="fs-tiny mb-1" style={{ color: '#00ff88' }}>判定依据</div>
                <div className="fs-small" style={{ color: '#c9d4e0' }}>{detail.evidence}</div>
              </div>
            )}

            <Block title="请求原文" content={detail.request} />
            <Block title="响应原文(截断)" content={detail.response} />
          </div>
        )}
      </Modal>
    </div>
  );
}
