import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  GitBranch, Play, Check, X, HelpCircle, RotateCcw, Fingerprint as FpIcon, Layers,
  ShieldOff, Save, Filter, ChevronRight,
} from 'lucide-react';
import {
  allRecords, createRecord, updateRecord, type ReviewItem, type FpFingerprint, type RuleStat,
  type ReviewState, type Verdict, type Tier,
} from '../lib/api';
import {
  applicableChecks, computeConfidence, dedupKey, fingerprintOf, fpMatch, normalizeResponse,
  parseChecks, profileResponse, rulePenalty, serializeChecks, splitForReport, STATE_META,
  TIER_META, verdictToState, nextStates, type CheckResult,
} from '../lib/review';
import {
  ConfidenceMeter, EmptyState, Modal, OriginChip, ReviewStateChip, Select, Spinner,
  TextInput, TierBadge, Kv, notify, fmtRelative, CopyButton,
} from '../components/kit';

const WAF_SIG = /cloudflare|cf-ray|incapsula|sucuri|mod_security|安全狗|云锁|阿里云盾|Attention Required|Request blocked|拦截/i;

function CheckRow({
  check, onSet,
}: {
  check: CheckResult;
  onSet: (state: CheckResult['state']) => void;
}) {
  const meta: Record<CheckResult['state'], { c: string; label: string }> = {
    pass: { c: '#00ff88', label: '通过' },
    fail: { c: '#ff2b3d', label: '失败' },
    todo: { c: '#7d9b8a', label: '未做' },
    na: { c: '#4e6b5c', label: '不适用' },
  };
  const m = meta[check.state];
  return (
    <div className="flex items-center gap-2 flex-wrap" style={{ padding: '0.4rem 0', borderBottom: '1px dashed rgba(0,255,136,0.1)' }}>
      <span className="fs-small font-mono" style={{ color: '#b8d6c4', minWidth: 74 }}>{check.id}</span>
      <div className="flex gap-1">
        {(['pass', 'fail', 'todo', 'na'] as const).map((s) => (
          <button
            key={s}
            onClick={() => onSet(s)}
            className="chip"
            style={{
              color: check.state === s ? meta[s].c : '#4e6b5c',
              borderColor: check.state === s ? `${meta[s].c}66` : 'rgba(0,255,136,0.12)',
              background: check.state === s ? `${meta[s].c}14` : 'transparent',
            }}
          >
            {meta[s].label}
          </button>
        ))}
      </div>
      <span className="fs-tiny flex-1 min-w-0" style={{ color: '#7d9b8a', overflowWrap: 'anywhere' }}>{check.note}</span>
      <span className="fs-tiny font-mono" style={{ color: m.c }}>{m.label}</span>
    </div>
  );
}

export function ReviewPage() {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [fps, setFps] = useState<FpFingerprint[]>([]);
  const [stats, setStats] = useState<RuleStat[]>([]);
  const [stateFilter, setStateFilter] = useState('');
  const [tierFilter, setTierFilter] = useState('');
  const [originFilter, setOriginFilter] = useState('');
  const [q, setQ] = useState('');
  const [detail, setDetail] = useState<ReviewItem | null>(null);
  const [checks, setChecks] = useState<CheckResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [triaging, setTriaging] = useState(false);

  const load = useCallback(async () => {
    const [queue, fingerprints, ruleStats] = await Promise.all([
      allRecords<ReviewItem>('review_queue', { sort: '-created', perPage: 200 }, 300).catch(() => [] as ReviewItem[]),
      allRecords<FpFingerprint>('fp_fingerprints', { sort: '-created', perPage: 200 }, 300).catch(() => [] as FpFingerprint[]),
      allRecords<RuleStat>('rule_stats', { sort: '-created', perPage: 200 }, 300).catch(() => [] as RuleStat[]),
    ]);
    setItems(queue);
    setFps(fingerprints);
    setStats(ruleStats);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const ruleMap = useMemo(() => new Map(stats.map((s) => [s.rule_id, s])), [stats]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((it) => {
      if (stateFilter && it.state !== stateFilter) return false;
      if (tierFilter && (it.tier || 'suspect') !== tierFilter) return false;
      if (originFilter && (it.origin || 'scanner') !== originFilter) return false;
      if (needle && !`${it.title} ${it.url} ${it.rule_id} ${it.parameter}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [items, stateFilter, tierFilter, originFilter, q]);

  const counts = useMemo(() => {
    const out: Record<string, number> = { total: items.length, pending: 0, confirmed: 0, rejected: 0, noise: 0 };
    for (const it of items) {
      if (it.state === 'confirmed') out.confirmed += 1;
      else if (it.state === 'rejected') out.rejected += 1;
      else out.pending += 1;
      if ((it.tier || '') === 'noise') out.noise += 1;
    }
    return out;
  }, [items]);

  const grouped = useMemo(() => {
    const map = new Map<string, ReviewItem[]>();
    for (const it of filtered) {
      const key = it.dedup_hash || dedupKey({ rule_id: it.rule_id, url: it.url, parameter: it.parameter });
      const arr = map.get(key);
      if (arr) arr.push(it); else map.set(key, [it]);
    }
    return Array.from(map.entries()).map(([key, group]) => ({ key, group, head: group[0] }))
      .sort((a, b) => b.group.length - a.group.length);
  }, [filtered]);

  /** 自动降噪 + 置信度计算，把 new 推到待人工 */
  const runTriage = async () => {
    setTriaging(true);
    const targets = items.filter((it) => it.state === 'new' || it.state === 'normalized' || !it.confidence);
    let done = 0;
    for (const it of targets) {
      const prof = profileResponse(it.raw_response);
      const matched = fpMatch({ rule_id: it.rule_id, url: it.url, raw_response: it.raw_response }, fps);
      const rule = ruleMap.get(it.rule_id || '');
      const wafBlocked = WAF_SIG.test(it.raw_response || '');
      const ruleCheck: CheckResult[] = applicableChecks({ title: it.title, rule_id: it.rule_id }).map((c) => ({
        id: c.id, state: 'todo', note: c.detail,
      }));
      const result = computeConfidence({
        checks: ruleCheck,
        severity: it.severity,
        sources: 1,
        wafBlocked,
        fpHits: [
          ...matched.map((f) => ({ rule_id: f.rule_id, resp_sig: f.resp_sig, penalty: f.penalty ?? 25, reason: f.reason })),
          ...(rule && rulePenalty(rule) > 0 ? [{ rule_id: rule.rule_id, penalty: rulePenalty(rule), reason: rule.note || '规则精度偏低' }] : []),
        ],
      });
      const hash = it.dedup_hash || dedupKey({ rule_id: it.rule_id, url: it.url, parameter: it.parameter });
      const instances = items.filter((x) => (x.dedup_hash || dedupKey({ rule_id: x.rule_id, url: x.url, parameter: x.parameter })) === hash).length;
      try {
        await updateRecord<ReviewItem>('review_queue', it.id, {
          state: 'awaiting_human',
          confidence: result.score,
          tier: result.tier,
          dedup_hash: hash,
          instances,
          checks: serializeChecks(ruleCheck),
          evidence: [
            `响应指纹 ${prof.sig}`,
            `归一化长度 ${prof.length}`,
            ...result.reasons,
            ...result.penalties,
            wafBlocked ? '⚠ 命中 WAF 拦截特征' : '',
          ].filter(Boolean).join('\n'),
        });
        done += 1;
      } catch { /* 单项失败不阻断 */ }
    }
    notify(done ? `降噪完成，重算 ${done} 条` : '没有需要重算的条目', done ? 'ok' : 'info');
    setTriaging(false);
    await load();
  };

  const openDetail = (it: ReviewItem) => {
    setDetail(it);
    const parsed = parseChecks(it.checks);
    setChecks(parsed.length ? parsed : applicableChecks({ title: it.title, rule_id: it.rule_id }).map((c) => ({ id: c.id, state: 'todo', note: c.detail })));
  };

  const recalc = (list: CheckResult[]) => {
    if (!detail) return null;
    const matched = fpMatch({ rule_id: detail.rule_id, url: detail.url, raw_response: detail.raw_response }, fps);
    const rule = ruleMap.get(detail.rule_id || '');
    return computeConfidence({
      checks: list,
      severity: detail.severity,
      sources: detail.origin === 'agent' ? 2 : 1,
      wafBlocked: WAF_SIG.test(detail.raw_response || ''),
      fpHits: [
        ...matched.map((f) => ({ rule_id: f.rule_id, resp_sig: f.resp_sig, penalty: f.penalty ?? 25 })),
        ...(rule && rulePenalty(rule) > 0 ? [{ rule_id: rule.rule_id, penalty: rulePenalty(rule), reason: rule.note }] : []),
      ],
    });
  };

  const live = useMemo(() => recalc(checks), [checks, detail, fps, ruleMap]);

  const persistChecks = async () => {
    if (!detail || !live) return;
    setBusy(true);
    try {
      await updateRecord('review_queue', detail.id, {
        checks: serializeChecks(checks),
        confidence: live.score,
        tier: live.tier,
        evidence: [
          `响应指纹 ${profileResponse(detail.raw_response).sig}`,
          ...live.reasons,
          ...live.penalties,
        ].join('\n'),
      });
      notify('检查项已保存，置信度已重算', 'ok');
      await load();
    } catch (err) {
      notify(err instanceof Error ? err.message : '保存失败', 'err');
    } finally {
      setBusy(false);
    }
  };

  const submitVerdict = async (verdict: Verdict) => {
    if (!detail) return;
    setBusy(true);
    const next = verdictToState(verdict);
    try {
      const note = live ? [
        `置信度 ${live.score}/${live.tier}`,
        ...live.reasons, ...live.penalties,
      ].join(' · ') : undefined;
      const patch: Record<string, unknown> = {
        state: next,
        verdict,
        verdict_note: note,
        checks: serializeChecks(checks),
        confidence: live?.score ?? detail.confidence,
        tier: live?.tier ?? detail.tier,
        verified_at: new Date().toISOString(),
        reviewer: 'human',
      };
      if (verdict === 'false_positive') {
        const fp = fingerprintOf({ rule_id: detail.rule_id, url: detail.url, raw_response: detail.raw_response });
        patch.fp_pattern = `${fp.rule_id} | ${fp.url_pattern} | ${fp.resp_sig}`;
        const exists = fps.find((f) => f.rule_id === fp.rule_id && f.resp_sig === fp.resp_sig);
        if (exists) {
          await updateRecord<FpFingerprint>('fp_fingerprints', exists.id, {
            hits: (exists.hits || 0) + 1, last_hit: new Date().toISOString(),
          });
        } else {
          await createRecord<FpFingerprint>('fp_fingerprints', {
            rule_id: fp.rule_id,
            url_pattern: fp.url_pattern,
            resp_sig: fp.resp_sig,
            reason: `人工驳回：${detail.title}`,
            hits: 1,
            penalty: 25,
            source: 'human',
            enabled: true,
            last_hit: new Date().toISOString(),
          });
        }
      }
      await updateRecord<ReviewItem>('review_queue', detail.id, patch);
      await refreshRuleStat(detail.rule_id || 'unknown', verdict);
      notify(verdict === 'false_positive' ? '已驳回，误报指纹入库' : '判定已写入', 'ok');
      setDetail(null);
      await load();
    } catch (err) {
      notify(err instanceof Error ? err.message : '写入失败', 'err');
    } finally {
      setBusy(false);
    }
  };

  const refreshRuleStat = async (ruleId: string, verdict: Verdict) => {
    const related = items.filter((x) => (x.rule_id || 'unknown') === ruleId);
    const confirmed = related.filter((x) => x.state === 'confirmed').length + (verdict === 'confirmed' ? 1 : 0);
    const rejected = related.filter((x) => x.state === 'rejected').length + (verdict === 'false_positive' ? 1 : 0);
    const uncertain = related.filter((x) => x.state === 'uncertain').length + (verdict === 'uncertain' ? 1 : 0);
    const hits = related.length + 1;
    const precision = hits ? Math.round((confirmed / hits) * 1000) / 10 : 0;
    const state = hits < 5 ? 'watch' : precision >= 70 ? 'active' : precision >= 40 ? 'downweighted' : 'retired';
    const existing = ruleMap.get(ruleId);
    try {
      if (existing) {
        await updateRecord<RuleStat>('rule_stats', existing.id, { hits, confirmed, rejected, uncertain, precision, state });
      } else {
        await createRecord<RuleStat>('rule_stats', { rule_id: ruleId, poc_name: ruleId, hits, confirmed, rejected, uncertain, precision, state });
      }
    } catch { /* 统计失败不影响判定 */ }
  };

  const bulkRejectNoise = async () => {
    const noise = items.filter((it) => (it.tier === 'noise') && it.state !== 'rejected' && it.state !== 'confirmed');
    if (!noise.length) { notify('没有疑似噪音条目', 'info'); return; }
    setBusy(true);
    let n = 0;
    for (const it of noise) {
      try {
        const fp = fingerprintOf({ rule_id: it.rule_id, url: it.url, raw_response: it.raw_response });
        await updateRecord('review_queue', it.id, {
          state: 'rejected', verdict: 'false_positive', reviewer: 'auto',
          verdict_note: '批量驳回：置信度低于 45，疑似软 404 / 指纹库重合',
          fp_pattern: `${fp.rule_id} | ${fp.url_pattern} | ${fp.resp_sig}`,
          verified_at: new Date().toISOString(),
        });
        const exists = fps.find((f) => f.rule_id === fp.rule_id && f.resp_sig === fp.resp_sig);
        if (!exists) {
          await createRecord('fp_fingerprints', {
            rule_id: fp.rule_id, url_pattern: fp.url_pattern, resp_sig: fp.resp_sig,
            reason: '批量驳回自动入库', hits: 1, penalty: 25, source: 'auto', enabled: true,
            last_hit: new Date().toISOString(),
          });
        }
        n += 1;
      } catch { /* 继续 */ }
    }
    setBusy(false);
    notify(`已批量驳回 ${n} 条，指纹已入库`, 'ok');
    await load();
  };

  const bundle = useMemo(() => splitForReport(items), [items]);

  if (loading) return <Spinner label="正在同步复核队列…" />;

  return (
    <div className="section-wrap">
      <div className="container-fluid flex flex-col" style={{ gap: 'var(--gap-fluid)' }}>
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <div className="cmd-label">review pipeline</div>
            <h2 className="fs-display" style={{ color: '#e8fff3' }}>
              <span className="glitch" data-text="复核工作台">复核工作台</span>
            </h2>
            <p className="fs-small" style={{ color: '#7d9b8a' }}>
              新发现 → 降噪归一化 → 主动证伪 → 人工判定 → 复测 · 驳回即写入误报指纹库，下次同指纹自动降权
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button className="btn btn-primary" disabled={triaging} onClick={() => void runTriage()}>
              <Play size={14} />{triaging ? '降噪中…' : '跑一遍自动降噪'}
            </button>
            <button className="btn btn-danger" disabled={busy} onClick={() => void bulkRejectNoise()}>
              <ShieldOff size={14} />批量驳回疑似({counts.noise})
            </button>
          </div>
        </div>

        <div className="grid-auto">
          {[
            { k: '队列总量', v: counts.total, c: '#b8d6c4' },
            { k: '待处理', v: counts.pending, c: '#ffb000' },
            { k: '已确认', v: counts.confirmed, c: '#00ff88' },
            { k: '已驳回', v: counts.rejected, c: '#ff2b3d' },
            { k: '整体精度', v: `${bundle.stats.precision}%`, c: '#38d9ff' },
          ].map((s) => (
            <div key={s.k} className="hud-panel hud-panel-hover" style={{ padding: '0.75rem 0.9rem' }}>
              <div className="cmd-label">{s.k}</div>
              <div className="fs-stat font-mono" style={{ color: s.c }}>{s.v}</div>
            </div>
          ))}
        </div>

        {/* 状态机图 */}
        <div className="hud-panel" style={{ padding: '0.85rem' }}>
          <div className="cmd-label mb-2">state machine</div>
          <div className="flex items-center gap-1 flex-wrap">
            {(['new', 'normalized', 'awaiting_human', 'auto_verified', 'confirmed'] as ReviewState[]).map((s, i, arr) => (
              <span key={s} className="flex items-center gap-1">
                <span className={`state-node ${items.some((it) => it.state === s) ? 'state-node-active' : ''}`}>
                  {STATE_META[s].label}
                  <span style={{ color: '#4e6b5c' }}>{items.filter((it) => it.state === s).length}</span>
                </span>
                {i < arr.length - 1 && <ChevronRight size={12} style={{ color: '#2c4739' }} />}
              </span>
            ))}
            <span className="flex items-center gap-1">
              <ChevronRight size={12} style={{ color: '#2c4739' }} />
              <span className={`state-node state-node-dead ${items.some((it) => it.state === 'rejected') ? '' : 'opacity-50'}`}>
                已驳回<span style={{ color: '#4e6b5c' }}>{counts.rejected}</span>
              </span>
              <span className="state-node" style={{ marginLeft: 6 }}>存疑 {items.filter((it) => it.state === 'uncertain').length}</span>
              <span className="state-node" style={{ marginLeft: 6 }}>待复测 {items.filter((it) => it.state === 'retest').length}</span>
            </span>
          </div>
        </div>

        <div className="hud-panel">
          <div className="panel-head">
            <Filter size={13} />筛选
            <span className="ml-auto fs-tiny" style={{ color: '#4e6b5c' }}>{filtered.length} / {items.length}</span>
          </div>
          <div className="grid gap-2" style={{ padding: '0.8rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px,100%), 1fr))' }}>
            <Select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
              <option value="">全部状态</option>
              {(Object.keys(STATE_META) as ReviewState[]).map((s) => <option key={s} value={s}>{STATE_META[s].label}</option>)}
            </Select>
            <Select value={tierFilter} onChange={(e) => setTierFilter(e.target.value)}>
              <option value="">全部分档</option>
              {(['confirmed', 'suspect', 'noise'] as Tier[]).map((t) => <option key={t} value={t}>{TIER_META[t].label}</option>)}
            </Select>
            <Select value={originFilter} onChange={(e) => setOriginFilter(e.target.value)}>
              <option value="">全部来源</option>
              <option value="scanner">扫描器</option>
              <option value="agent">Agent</option>
              <option value="manual">人工</option>
            </Select>
            <TextInput value={q} placeholder="搜规则 / URL / 参数…" onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>

        {grouped.length === 0 ? (
          <EmptyState
            icon={<GitBranch size={22} />}
            title="复核队列是空的"
            desc="去「漏洞发现」把命中入队，或让 Agent 直接上报到 review_queue"
          />
        ) : (
          <div className="hud-panel overflow-hidden">
            <div className="panel-head">
              <Layers size={13} />队列（同指纹已合并，显示实例数）
            </div>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>规则</th><th>标题 / URL</th><th>严重度</th><th>置信度</th><th>状态</th><th>来源</th><th>实例</th><th />
                  </tr>
                </thead>
                <tbody>
                  {grouped.map(({ key, group, head }) => (
                    <tr key={key}>
                      <td className="font-mono fs-tiny" style={{ color: '#00ff88' }}>{head.rule_id || '—'}</td>
                      <td className="min-w-0" style={{ maxWidth: 380 }}>
                        <div className="truncate" style={{ color: '#e8fff3' }}>{head.title}</div>
                        <div className="truncate fs-tiny" style={{ color: '#4e6b5c' }}>{head.url || '—'} {head.parameter ? `[${head.parameter}]` : ''}</div>
                      </td>
                      <td className="fs-tiny">{head.severity}</td>
                      <td><ConfidenceMeter score={head.confidence} tier={head.tier as Tier} /></td>
                      <td><ReviewStateChip state={head.state} /></td>
                      <td><OriginChip origin={head.origin} agent={head.agent_name} /></td>
                      <td className="font-mono fs-tiny" style={{ color: group.length > 1 ? '#ffb000' : '#4e6b5c' }}>×{group.length}</td>
                      <td>
                        <button className="btn btn-ghost btn-sm" onClick={() => openDetail(head)}>复核</button>
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
        wide
        title={detail ? `复核 · ${detail.title}` : ''}
        footer={(
          <div className="flex gap-2 flex-wrap justify-end">
            <button className="btn btn-ghost" disabled={busy} onClick={() => void persistChecks()}><Save size={13} />保存检查项</button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => void submitVerdict('need_retest')}><RotateCcw size={13} />待复测</button>
            <button className="btn btn-accent" disabled={busy} onClick={() => void submitVerdict('uncertain')}><HelpCircle size={13} />存疑进附录</button>
            <button className="btn btn-danger" disabled={busy} onClick={() => void submitVerdict('false_positive')}><X size={13} />驳回并入库指纹</button>
            <button className="btn btn-primary" disabled={busy} onClick={() => void submitVerdict('confirmed')}><Check size={13} />确认进主文</button>
          </div>
        )}
      >
        {detail && (
          <div className="flex flex-col gap-3">
            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px,100%), 1fr))' }}>
              <div className="hud-panel" style={{ padding: '0.7rem 0.85rem' }}>
                <div className="cmd-label mb-1">当前判定</div>
                <div className="flex items-center gap-2 flex-wrap">
                  <ReviewStateChip state={detail.state} />
                  <TierBadge tier={(live?.tier || detail.tier) as Tier} score={live?.score ?? detail.confidence} />
                  <OriginChip origin={detail.origin} agent={detail.agent_name} />
                </div>
                <div className="mt-2"><ConfidenceMeter score={live?.score ?? detail.confidence} tier={(live?.tier || detail.tier) as Tier} /></div>
                {live && (
                  <div className="fs-tiny mt-2" style={{ color: '#7d9b8a' }}>
                    {TIER_META[live.tier].hint}
                  </div>
                )}
              </div>
              <div className="hud-panel" style={{ padding: '0.7rem 0.85rem' }}>
                <div className="cmd-label mb-1">台账</div>
                <Kv k="规则" v={detail.rule_id || '—'} />
                <Kv k="URL" v={detail.url || '—'} />
                <Kv k="参数" v={detail.parameter || '—'} />
                <Kv k="位置" v={detail.location || '—'} />
                <Kv k="规范化端点" v={detail.endpoint_norm || '—'} />
                <Kv k="授权范围" v={detail.scope || '—'} />
                <Kv k="指纹" v={detail.dedup_hash || dedupKey({ rule_id: detail.rule_id, url: detail.url, parameter: detail.parameter })} />
                <Kv k="实例" v={`×${detail.instances ?? 1}`} />
                <Kv k="实体版本" v={`rev ${detail.rev ?? 1}`} />
                <Kv k="租约" v={detail.claimed_by ? `${detail.claimed_by}（至 ${fmtRelative(detail.lease_expires_at)}）` : '未领取'} />
                {detail.supersedes && <Kv k="取代了" v={detail.supersedes} />}
                {detail.superseded_by && <Kv k="已被取代" v={detail.superseded_by} />}
                {detail.reopened_reason && <Kv k="重开原因" v={detail.reopened_reason} />}
                <Kv k="入队" v={fmtRelative(detail.created)} />
              </div>
            </div>

            <div className="hud-panel" style={{ padding: '0.7rem 0.85rem' }}>
              <div className="cmd-label mb-1">主动证伪 · 检查项（改动即实时重算置信度）</div>
              {checks.map((c, i) => (
                <CheckRow
                  key={c.id}
                  check={c}
                  onSet={(s) => setChecks((prev) => prev.map((x, j) => (j === i ? { ...x, state: s } : x)))}
                />
              ))}
              {live && (
                <div className="mt-2 fs-tiny" style={{ color: '#7d9b8a' }}>
                  <div>加分项：{live.reasons.length ? live.reasons.join(' · ') : '无'}</div>
                  <div style={{ color: live.penalties.length ? '#ff8a94' : '#7d9b8a' }}>扣分项：{live.penalties.length ? live.penalties.join(' · ') : '无'}</div>
                </div>
              )}
            </div>

            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px,100%), 1fr))' }}>
              <div className="hud-panel" style={{ padding: '0.7rem 0.85rem' }}>
                <div className="cmd-label mb-1 flex items-center gap-2">
                  原始请求
                  <CopyButton text={detail.raw_request || detail.curl || ''} />
                </div>
                <div className="terminal" style={{ maxHeight: 180 }}>{detail.raw_request || 'GET / HTTP/1.1\nHost: <target>\nUser-Agent: reconlab/2.0\nAccept: */*\n\n（本条没记录原始请求）'}</div>
              </div>
              <div className="hud-panel" style={{ padding: '0.7rem 0.85rem' }}>
                <div className="cmd-label mb-1">归一化后（已剥时间戳 / nonce / token）</div>
                <div className="terminal" style={{ maxHeight: 180 }}>{normalizeResponse(detail.raw_response).slice(0, 1400) || '—'}</div>
              </div>
            </div>

            <div className="hud-panel" style={{ padding: '0.7rem 0.85rem' }}>
              <div className="cmd-label mb-1 flex items-center gap-2">
                可复现命令
                <CopyButton text={detail.curl || ''} />
              </div>
              <div className="terminal" style={{ maxHeight: 110 }}>{detail.curl || '未记录原始请求，无法生成'}</div>
              <div className="fs-tiny mt-2" style={{ color: '#4e6b5c' }}>
                响应指纹 {profileResponse(detail.raw_response).sig} · 归一化长度 {profileResponse(detail.raw_response).length}
                {WAF_SIG.test(detail.raw_response || '') && <span style={{ color: '#ff2b3d' }}> · 命中 WAF 拦截特征，先排除拦截再判定</span>}
              </div>
            </div>

            {detail.state !== 'confirmed' && (
              <div className="fs-tiny" style={{ color: '#4e6b5c' }}>
                <FpIcon size={11} className="inline mr-1" />
                可流转状态：{nextStates(detail.state).map((s) => STATE_META[s].label).join(' / ') || '—（终态）'}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
