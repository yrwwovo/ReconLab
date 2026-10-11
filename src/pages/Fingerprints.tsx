import { useCallback, useEffect, useMemo, useState } from 'react';
import { Fingerprint as FpIcon, Plus, Trash2, Power, Ruler, FlaskConical, TrendingUp } from 'lucide-react';
import {
  allRecords, createRecord, deleteRecord, updateRecord, type FpFingerprint, type RuleStat,
} from '../lib/api';
import {
  buildSoftBaseline, computePrecision, fingerprintOf, normalizeResponse,
  profileResponse, RULE_STATE_META, shingles, ruleStateFor,
} from '../lib/review';
import { EmptyState, Modal, Select, Spinner, TextArea, TextInput, notify, fmtRelative, CopyButton } from '../components/kit';

function PrecisionBar({ value, state }: { value: number; state?: RuleStat['state'] }) {
  const color = state === 'active' ? '#00ff88' : state === 'watch' ? '#38d9ff' : state === 'downweighted' ? '#ffb000' : '#ff2b3d';
  return (
    <div className="flex items-center gap-2" style={{ minWidth: 130 }}>
      <div className="flex-1" style={{ height: 6, background: 'rgba(0,255,136,0.08)', border: '1px solid rgba(0,255,136,0.14)' }}>
        <div style={{ width: `${Math.min(100, value)}%`, height: '100%', background: color, boxShadow: `0 0 10px ${color}88` }} />
      </div>
      <span className="fs-tiny font-mono" style={{ color, width: 38, textAlign: 'right' }}>{value}%</span>
    </div>
  );
}

export function FingerprintsPage() {
  const [loading, setLoading] = useState(true);
  const [fps, setFps] = useState<FpFingerprint[]>([]);
  const [stats, setStats] = useState<RuleStat[]>([]);
  const [tab, setTab] = useState<'fp' | 'rules' | 'lab'>('fp');
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({ rule_id: '', url_pattern: '', resp_sig: '', reason: '', penalty: '25' });

  /* 离线降噪实验室 */
  const [sampleHit, setSampleHit] = useState('');
  const [sampleBase, setSampleBase] = useState('');

  const load = useCallback(async () => {
    const [fpList, ruleList] = await Promise.all([
      allRecords<FpFingerprint>('fp_fingerprints', { sort: '-hits', perPage: 200 }, 400).catch(() => [] as FpFingerprint[]),
      allRecords<RuleStat>('rule_stats', { sort: '-hits', perPage: 200 }, 400).catch(() => [] as RuleStat[]),
    ]);
    setFps(fpList);
    setStats(ruleList);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const labResult = useMemo(() => {
    if (!sampleHit.trim() || !sampleBase.trim()) return null;
    const baseLines = sampleBase.split(/\n-{3,}\n/).map((s) => s.trim()).filter(Boolean);
    const baseline = buildSoftBaseline(baseLines.map((body) => ({ url: 'baseline', body })));
    const isSoft = baseline.isSoft(sampleHit);
    const sim = baseline.similarTo(sampleHit);
    const hitProfile = profileResponse(sampleHit);
    const baseProfiles = baseLines.map((b) => profileResponse(b));
    const sigCollision = baseProfiles.some((p) => p.sig === hitProfile.sig);
    return { isSoft, sim, hitProfile, baseProfiles, sigCollision, count: baseLines.length };
  }, [sampleHit, sampleBase]);

  const toggle = async (fp: FpFingerprint) => {
    try {
      await updateRecord('fp_fingerprints', fp.id, { enabled: !fp.enabled });
      notify(fp.enabled ? '指纹已停用' : '指纹已启用', 'ok');
      await load();
    } catch { notify('操作失败', 'err'); }
  };

  const remove = async (fp: FpFingerprint) => {
    try {
      await deleteRecord('fp_fingerprints', fp.id);
      notify('已删除', 'ok');
      await load();
    } catch { notify('删除失败', 'err'); }
  };

  const submit = async () => {
    if (!form.rule_id.trim()) { notify('规则 ID 必填', 'err'); return; }
    try {
      await createRecord('fp_fingerprints', {
        rule_id: form.rule_id.trim(),
        url_pattern: form.url_pattern.trim(),
        resp_sig: form.resp_sig.trim(),
        reason: form.reason.trim() || '人工登记',
        hits: 1,
        penalty: Number(form.penalty) || 25,
        source: 'human',
        enabled: true,
        last_hit: new Date().toISOString(),
      });
      setFormOpen(false);
      setForm({ rule_id: '', url_pattern: '', resp_sig: '', reason: '', penalty: '25' });
      notify('指纹已入库', 'ok');
      await load();
    } catch { notify('入库失败', 'err'); }
  };

  const recomputeRules = async () => {
    let n = 0;
    for (const stat of stats) {
      const hits = stat.hits || 0;
      const precision = computePrecision(hits, stat.confirmed || 0);
      const state = ruleStateFor(hits, precision);
      if (precision !== stat.precision || state !== stat.state) {
        try {
          await updateRecord('rule_stats', stat.id, { precision, state });
          n += 1;
        } catch { /* 继续 */ }
      }
    }
    notify(n ? `已重算 ${n} 条规则精度` : '精度已是最新', n ? 'ok' : 'info');
    await load();
  };

  const rulesSorted = useMemo(
    () => [...stats].sort((a, b) => (a.precision || 0) - (b.precision || 0)),
    [stats],
  );

  if (loading) return <Spinner label="正在载入指纹库…" />;

  return (
    <div className="section-wrap">
      <div className="container-fluid flex flex-col" style={{ gap: 'var(--gap-fluid)' }}>
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <div className="cmd-label">false-positive control</div>
            <h2 className="fs-display" style={{ color: '#e8fff3' }}>
              <span className="glitch" data-text="误报指纹库">误报指纹库</span>
            </h2>
            <p className="fs-small" style={{ color: '#7d9b8a' }}>
              驳回一条发现 = 记一条指纹。同规则 + 同 URL 形态 + 同响应骨架再次出现时，置信度自动被打折，不再当成新漏洞报上来
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button className="btn btn-ghost" onClick={() => setFormOpen(true)}><Plus size={14} />手工登记指纹</button>
            <button className="btn btn-primary" onClick={() => void recomputeRules()}><TrendingUp size={14} />重算规则精度</button>
          </div>
        </div>

        <div className="flex gap-1 flex-wrap">
          {([
            ['fp', '指纹库', FpIcon],
            ['rules', '规则精度', Ruler],
            ['lab', '降噪实验室', FlaskConical],
          ] as const).map(([id, label, Icon]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className="btn"
              style={{
                background: tab === id ? 'rgba(0,255,136,0.12)' : 'transparent',
                borderColor: tab === id ? 'rgba(0,255,136,0.42)' : 'rgba(0,255,136,0.14)',
                color: tab === id ? '#00ff88' : '#7d9b8a',
              }}
            >
              <Icon size={13} />{label}
            </button>
          ))}
        </div>

        {tab === 'fp' && (
          fps.length === 0 ? (
            <EmptyState icon={<FpIcon size={22} />} title="还没有误报指纹" desc="在复核台驳回一条发现，指纹会自动写进这里" />
          ) : (
            <div className="hud-panel overflow-hidden">
              <div className="panel-head"><FpIcon size={13} />指纹条目 {fps.length}</div>
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr><th>规则</th><th>URL 形态</th><th>响应指纹</th><th>命中</th><th>折扣</th><th>来源</th><th>最近命中</th><th>状态</th><th /></tr>
                  </thead>
                  <tbody>
                    {fps.map((fp) => (
                      <tr key={fp.id} style={{ opacity: fp.enabled ? 1 : 0.45 }}>
                        <td className="font-mono fs-tiny" style={{ color: '#00ff88' }}>{fp.rule_id || '—'}</td>
                        <td className="font-mono fs-tiny" style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fp.url_pattern || '*'}</td>
                        <td className="font-mono fs-tiny" style={{ color: '#7d9b8a' }}>{fp.resp_sig || '—'}</td>
                        <td className="font-mono fs-tiny" style={{ color: '#ffb000' }}>{fp.hits ?? 0}</td>
                        <td className="font-mono fs-tiny" style={{ color: '#ff8a94' }}>-{fp.penalty ?? 25}</td>
                        <td className="fs-tiny">{fp.source === 'agent' ? 'Agent' : fp.source === 'auto' ? '自动' : '人工'}</td>
                        <td className="fs-tiny" style={{ color: '#4e6b5c' }}>{fmtRelative(fp.last_hit)}</td>
                        <td>
                          <button className="btn btn-ghost btn-sm" onClick={() => void toggle(fp)}>
                            <Power size={11} style={{ color: fp.enabled ? '#00ff88' : '#ff2b3d' }} />{fp.enabled ? '启用' : '停用'}
                          </button>
                        </td>
                        <td>
                          <button className="btn btn-ghost btn-sm" onClick={() => void remove(fp)}><Trash2 size={11} /></button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )
        )}

        {tab === 'rules' && (
          stats.length === 0 ? (
            <EmptyState icon={<Ruler size={22} />} title="还没有规则统计" desc="每次判定都会回写命中/确认/驳回，攒够样本自动分档" />
          ) : (
            <div className="hud-panel overflow-hidden">
              <div className="panel-head"><Ruler size={13} />命中-确认率（升序，最烂的排最前）</div>
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr><th>规则</th><th>命中</th><th>确认</th><th>驳回</th><th>存疑</th><th>精度</th><th>处置</th></tr>
                  </thead>
                  <tbody>
                    {rulesSorted.map((r) => (
                      <tr key={r.id}>
                        <td className="font-mono fs-tiny" style={{ color: '#00ff88' }}>{r.rule_id}</td>
                        <td className="font-mono fs-tiny">{r.hits ?? 0}</td>
                        <td className="font-mono fs-tiny" style={{ color: '#00ff88' }}>{r.confirmed ?? 0}</td>
                        <td className="font-mono fs-tiny" style={{ color: '#ff2b3d' }}>{r.rejected ?? 0}</td>
                        <td className="font-mono fs-tiny" style={{ color: '#ffb000' }}>{r.uncertain ?? 0}</td>
                        <td><PrecisionBar value={r.precision ?? 0} state={r.state} /></td>
                        <td>
                          <span className="chip" style={{ color: RULE_STATE_META[r.state || 'watch'].tone === 'ok' ? '#00ff88' : RULE_STATE_META[r.state || 'watch'].tone === 'bad' ? '#ff2b3d' : RULE_STATE_META[r.state || 'watch'].tone === 'warn' ? '#ffb000' : '#7d9b8a' }}>
                            {RULE_STATE_META[r.state || 'watch'].label}
                          </span>
                          <div className="fs-tiny mt-1" style={{ color: '#4e6b5c' }}>{RULE_STATE_META[r.state || 'watch'].desc}</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )
        )}

        {tab === 'lab' && (
          <div className="flex flex-col gap-3">
            <div className="hud-panel" style={{ padding: '0.85rem' }}>
              <div className="cmd-label mb-2">离线降噪实验室 · 判断一条命中到底是不是软 404 / 通配页</div>
              <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px,100%), 1fr))' }}>
                <div>
                  <div className="field-label">疑似命中的响应体</div>
                  <TextArea rows={8} value={sampleHit} onChange={(e) => setSampleHit(e.target.value)} placeholder="把命中那条的响应原文贴进来…" />
                </div>
                <div>
                  <div className="field-label">基线样本（多条用 --- 分隔）</div>
                  <TextArea rows={8} value={sampleBase} onChange={(e) => setSampleBase(e.target.value)} placeholder={'不存在的路径返回体\n---\n另一个不存在路径的返回体\n---\n随机参数返回体'} />
                </div>
              </div>
              {labResult && (
                <div className="mt-3 flex flex-col gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="chip" style={{ color: labResult.isSoft ? '#ff2b3d' : '#00ff88', borderColor: labResult.isSoft ? 'rgba(255,43,61,0.4)' : 'rgba(0,255,136,0.4)' }}>
                      {labResult.isSoft ? '判定：软 404 / 通配页 → 应驳回' : '判定：与基线不重合 → 值得人工看'}
                    </span>
                    <span className="chip" style={{ color: '#7d9b8a' }}>最高相似度 {(labResult.sim * 100).toFixed(1)}%</span>
                    <span className="chip" style={{ color: '#7d9b8a' }}>基线 {labResult.count} 条</span>
                    {labResult.sigCollision && <span className="chip" style={{ color: '#ffb000' }}>稳定指纹与基线完全相同</span>}
                  </div>
                  <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px,100%), 1fr))' }}>
                    <div className="hud-panel" style={{ padding: '0.6rem 0.75rem' }}>
                      <div className="cmd-label mb-1 flex items-center gap-2">命中响应指纹 <CopyButton text={labResult.hitProfile.sig} /></div>
                      <div className="terminal" style={{ maxHeight: 100 }}>{`sig      ${labResult.hitProfile.sig}\nstatus   ${labResult.hitProfile.status ?? '-'}\ntitle    ${labResult.hitProfile.title || '(空)'}\nlen      ${labResult.hitProfile.length}\nct       ${labResult.hitProfile.ct || '-'}`}</div>
                    </div>
                    <div className="hud-panel" style={{ padding: '0.6rem 0.75rem' }}>
                      <div className="cmd-label mb-1">基线指纹</div>
                      <div className="terminal" style={{ maxHeight: 100 }}>
                        {labResult.baseProfiles.map((p, i) => `#${i + 1} ${p.sig} len=${p.length}`).join('\n') || '—'}
                      </div>
                    </div>
                  </div>
                  <div className="fs-tiny" style={{ color: '#4e6b5c' }}>
                    相似度按内容 5-gram shingle 的 Jaccard 系数算，长度比对会被缓存和随机 nonce 骗，shingle 不会。归一化后 shingle 集大小 {shingles(normalizeResponse(sampleHit)).size}。
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title="手工登记误报指纹"
        footer={(
          <div className="flex gap-2 justify-end">
            <button className="btn btn-ghost" onClick={() => setFormOpen(false)}>取消</button>
            <button className="btn btn-primary" onClick={() => void submit()}>入库</button>
          </div>
        )}
      >
        <div className="flex flex-col gap-3">
          <div>
            <div className="field-label">规则 ID / POC 名</div>
            <TextInput value={form.rule_id} onChange={(e) => setForm({ ...form, rule_id: e.target.value })} placeholder="例如 sql-error-based" />
          </div>
          <div>
            <div className="field-label">URL 形态（支持 * 通配）</div>
            <TextInput value={form.url_pattern} onChange={(e) => setForm({ ...form, url_pattern: e.target.value })} placeholder="example.com/api/*/detail?*" />
          </div>
          <div>
            <div className="field-label">响应稳定指纹（可留空只看规则+URL）</div>
            <TextInput value={form.resp_sig} onChange={(e) => setForm({ ...form, resp_sig: e.target.value })} placeholder="200|12|Not Found|text/html|a1b2c3d4" />
          </div>
          <div>
            <div className="field-label">置信度折扣（命中一次扣多少分）</div>
            <Select value={form.penalty} onChange={(e) => setForm({ ...form, penalty: e.target.value })}>
              <option value="15">15 · 轻</option>
              <option value="25">25 · 标准</option>
              <option value="35">35 · 重</option>
              <option value="45">45 · 直接压到疑似</option>
            </Select>
          </div>
          <div>
            <div className="field-label">备注</div>
            <TextArea rows={3} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="为什么判它是误报" />
          </div>
          <div className="fs-tiny" style={{ color: '#4e6b5c' }}>
            响应指纹可用左侧「降噪实验室」算出来复制过来。当前条目所含指纹示例：{fingerprintOf({ rule_id: form.rule_id, url: form.url_pattern, raw_response: '' }).resp_sig}
          </div>
        </div>
      </Modal>
    </div>
  );
}
