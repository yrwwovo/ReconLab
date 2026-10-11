import { useEffect, useMemo, useState } from 'react';
import {
  ScanLine, Plus, Search, Trash2, RotateCw, XOctagon, ArrowRight, Globe, Network, FolderSearch, ShieldAlert, FlaskConical,
} from 'lucide-react';
import { allRecords, createRecord, deleteRecord, listRecords, updateRecord, type Poc, type Scan, type ScanKind, type Target } from '../lib/api';
import { navigate } from '../lib/router';
import { EmptyState, Field, Modal, Select, Spinner, StatusChip, TextInput, notify, fmtRelative } from '../components/kit';

export const KIND_META: Record<ScanKind, { label: string; icon: typeof Globe; desc: string }> = {
  subdomain: { label: '子域枚举', icon: Globe, desc: '字典 + DNS 解析 + 证书透明日志,找出暴露的入口' },
  port: { label: '端口扫描', icon: Network, desc: 'TCP 连接扫描,识别开放端口与服务指纹' },
  http: { label: '指纹探测', icon: FolderSearch, desc: '状态码 / 标题 / 中间件 / 技术栈 / TLS 证书' },
  dir: { label: '目录爆破', icon: FolderSearch, desc: '字典探测敏感路径与后台入口,按响应长度去噪' },
  vuln: { label: '漏洞扫描', icon: ShieldAlert, desc: '内置检测器:配置错误 / 敏感文件 / 注入 / 未授权访问' },
  poc: { label: 'POC 验证', icon: FlaskConical, desc: '按 POC 库模板批量验证,回显比对 + 多轮复核' },
};

const DICT_OPTS = [
  { value: 'small', label: '精简(快)' },
  { value: 'medium', label: '标准' },
  { value: 'large', label: '完整(慢)' },
];

const PORT_OPTS = [
  { value: 'top100', label: '常用 100 端口' },
  { value: 'top1000', label: '常见 1000 端口' },
  { value: 'full', label: '全端口 1-65535(慢)' },
];

const VULN_CHECKS = [
  { key: 'headers', label: '安全响应头缺失' },
  { key: 'cors', label: 'CORS 配置错误' },
  { key: 'sensitive', label: '敏感文件泄露' },
  { key: 'exposure', label: '后台/接口未授权暴露' },
  { key: 'sqli', label: 'SQL 注入(时间盲注)' },
  { key: 'xss', label: '反射型 XSS' },
  { key: 'redirect', label: '开放重定向' },
  { key: 'traversal', label: '目录遍历' },
  { key: 'methods', label: '危险 HTTP 方法' },
  { key: 'tls', label: 'TLS 弱配置' },
];

interface FormState {
  target: string;
  kinds: ScanKind[];
  concurrency: number;
  timeout: number;
  useExternal: boolean;
  dict: string;
  ports: string;
  followRedirect: boolean;
  checks: string[];
  pocIds: string[];
  safeMode: boolean;
}

const initialForm: FormState = {
  target: '',
  kinds: ['subdomain', 'http'],
  concurrency: 20,
  timeout: 8,
  useExternal: true,
  dict: 'medium',
  ports: 'top100',
  followRedirect: true,
  checks: VULN_CHECKS.map((c) => c.key),
  pocIds: [],
  safeMode: true,
};

function parseQuery(): URLSearchParams {
  const hash = window.location.hash.replace(/^#/, '');
  const idx = hash.indexOf('?');
  return new URLSearchParams(idx >= 0 ? hash.slice(idx + 1) : '');
}

export function ScansPage() {
  const [loading, setLoading] = useState(true);
  const [scans, setScans] = useState<Scan[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [pocs, setPocs] = useState<Poc[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<'all' | 'active' | 'done' | 'failed'>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>({ ...initialForm });
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState<Scan | null>(null);

  const loadScans = async (p = page) => {
    const res = await listRecords<Scan>('scans', {
      perPage: 20, page: p, sort: '-created',
      fields: 'id,name,kind,status,progress,target,message,created,finished,stats,worker',
    });
    setScans(res.items);
    setTotal(res.totalItems);
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [tgt, pocRes] = await Promise.all([
          allRecords<Target>('targets', { perPage: 100, sort: '-created', fields: 'id,name,value,kind,scope,tags' }, 400),
          allRecords<Poc>('pocs', { perPage: 100, fields: 'id,name,severity,category,enabled' }, 300),
        ]);
        if (!alive) return;
        setTargets(tgt);
        setPocs(pocRes);
        await loadScans(1);
        const qs = parseQuery();
        const targetId = qs.get('target');
        if (targetId) {
          setForm({ ...initialForm, target: targetId });
          setOpen(true);
        }
      } catch (e) {
        notify(e instanceof Error ? e.message : '加载失败', 'err');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 有任务在跑时自动刷新
  useEffect(() => {
    const hasActive = scans.some((s) => s.status === 'running' || s.status === 'queued');
    if (!hasActive) return;
    const t = window.setInterval(() => { void loadScans(); }, 5000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scans]);

  const filtered = useMemo(() => {
    let list = scans;
    if (filter === 'active') list = list.filter((s) => s.status === 'running' || s.status === 'queued');
    if (filter === 'done') list = list.filter((s) => s.status === 'done');
    if (filter === 'failed') list = list.filter((s) => s.status === 'failed' || s.status === 'canceled');
    const key = q.trim().toLowerCase();
    if (key) list = list.filter((s) => (s.name || '').toLowerCase().includes(key) || (KIND_META[s.kind]?.label || '').includes(key));
    return list;
  }, [scans, filter, q]);

  const targetMap = useMemo(() => new Map(targets.map((t) => [t.id, t])), [targets]);

  const submit = async () => {
    if (!form.target) { notify('先选一个授权目标', 'err'); return; }
    if (form.kinds.length === 0) { notify('至少勾一个任务类型', 'err'); return; }
    const tgt = targetMap.get(form.target);
    if (tgt && tgt.scope === 'out') { notify('这个目标在授权范围外,不能下发任务', 'err'); return; }
    setBusy(true);
    try {
      const created: Scan[] = [];
      for (const kind of form.kinds) {
        const args: Record<string, unknown> = {
          concurrency: form.concurrency,
          timeout: form.timeout,
          use_external: form.useExternal,
          safe_mode: form.safeMode,
        };
        if (kind === 'subdomain') args.dict = form.dict;
        if (kind === 'port') args.ports = form.ports;
        if (kind === 'http') args.follow_redirect = form.followRedirect;
        if (kind === 'dir') { args.dict = form.dict; args.follow_redirect = form.followRedirect; }
        if (kind === 'vuln') args.checks = form.checks;
        if (kind === 'poc') args.poc_ids = form.pocIds;
        const rec = await createRecord<Scan>('scans', {
          name: `${targetMap.get(form.target)?.name || '目标'} · ${KIND_META[kind].label}`,
          kind,
          target: form.target,
          args: JSON.stringify(args),
          status: 'queued',
          progress: 0,
          message: '等待执行器领取',
        });
        created.push(rec);
      }
      notify(`已下发 ${created.length} 个任务,等执行器领取`, 'ok');
      setOpen(false);
      setForm({ ...initialForm });
      setPage(1);
      await loadScans(1);
    } catch (e) {
      notify(e instanceof Error ? e.message : '下发失败', 'err');
    } finally {
      setBusy(false);
    }
  };

  const rerun = async (s: Scan) => {
    try {
      await updateRecord<Scan>('scans', s.id, { status: 'queued', progress: 0, message: '重新排队', log: '', finished: null, worker: null });
      notify('已重新排队', 'ok');
      await loadScans();
    } catch (e) {
      notify(e instanceof Error ? e.message : '操作失败', 'err');
    }
  };

  const cancel = async (s: Scan) => {
    try {
      await updateRecord<Scan>('scans', s.id, { status: 'canceled', message: '已手动终止' });
      notify('已终止', 'ok');
      await loadScans();
    } catch (e) {
      notify(e instanceof Error ? e.message : '操作失败', 'err');
    }
  };

  const remove = async () => {
    if (!confirmDel) return;
    try {
      await deleteRecord('scans', confirmDel.id);
      notify('任务已删除', 'ok');
      await loadScans();
    } catch (e) {
      notify(e instanceof Error ? e.message : '删除失败', 'err');
    } finally {
      setConfirmDel(null);
    }
  };

  if (loading) return <Spinner label="正在拉取任务列表…" />;

  const totalPages = Math.max(1, Math.ceil(total / 20));

  return (
    <div className="section-wrap">
      <div className="container-fluid flex flex-col" style={{ gap: 'var(--gap-fluid)' }}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[160px]">
            <Search size={14} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: '#4a5768' }} />
            <TextInput placeholder="搜索任务…" value={q} onChange={(e) => setQ(e.target.value)} style={{ paddingLeft: 28 }} />
          </div>
          <div className="flex gap-1">
            {([['all', '全部'], ['active', '进行中'], ['done', '已完成'], ['failed', '异常']] as const).map(([key, label]) => (
              <button
                key={key}
                className={`btn !py-1.5 ${filter === key ? 'btn-accent' : 'btn-ghost'}`}
                onClick={() => setFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <button className="btn btn-primary" onClick={() => { setForm({ ...initialForm }); setOpen(true); }}>
            <Plus size={14} />新建任务
          </button>
        </div>

        {filtered.length === 0 ? (
          <div className="hud-panel">
            <EmptyState
              icon={<ScanLine size={30} />}
              title="没有任务"
              desc="从「授权目标」里挑一个目标,勾上要跑的类型,一次下发多条。"
              action={<button className="btn btn-primary mt-2" onClick={() => setOpen(true)}><Plus size={14} />新建任务</button>}
            />
          </div>
        ) : (
          <div className="flex flex-col" style={{ gap: 'var(--gap-fluid)' }}>
            {filtered.map((s) => {
              const meta = KIND_META[s.kind];
              const Icon = meta?.icon || ScanLine;
              const active = s.status === 'running' || s.status === 'queued';
              return (
                <div key={s.id} className="hud-panel hud-panel-hover p-3.5 min-w-0">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="grid place-items-center shrink-0" style={{ width: 34, height: 34, borderRadius: 5, background: 'rgba(34,227,160,0.08)', border: '1px solid rgba(34,227,160,0.24)', color: '#22e3a0' }}>
                      <Icon size={17} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <button className="fs-small font-medium truncate text-left" style={{ color: '#eaf1f8' }} onClick={() => navigate(`/scans/${s.id}`)}>
                          {s.name || meta?.label || s.kind}
                        </button>
                        <span className="chip">{meta?.label || s.kind}</span>
                        <StatusChip status={s.status} />
                      </div>
                      <div className="fs-tiny mt-1 truncate" style={{ color: '#5d6b7d' }}>
                        目标:{targetMap.get(s.target)?.value || '—'} · {s.message || '—'} · {fmtRelative(s.created)}
                      </div>
                      <div className="mt-2 h-1 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                        <div
                          style={{
                            width: `${Math.min(100, Math.max(0, s.progress || 0))}%`,
                            height: '100%',
                            background: s.status === 'failed' ? '#ff2d55' : 'linear-gradient(90deg,#0d5c46,#22e3a0)',
                            transition: 'width .4s ease',
                          }}
                        />
                      </div>
                      {s.stats && (
                        <div className="fs-tiny mt-1.5 font-mono" style={{ color: '#4cc9f0' }}>
                          {(() => {
                            try {
                              const st = typeof s.stats === 'string' ? JSON.parse(s.stats) : s.stats;
                              const parts = Object.entries(st as Record<string, unknown>)
                                .filter(([, v]) => typeof v === 'number' || typeof v === 'string')
                                .slice(0, 5)
                                .map(([k, v]) => `${k}: ${v}`);
                              return parts.join('  ·  ') || '';
                            } catch { return ''; }
                          })()}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col sm:flex-row items-end gap-1.5 shrink-0">
                      <button className="btn btn-ghost !py-1 !px-2" onClick={() => navigate(`/scans/${s.id}`)}>
                        <ArrowRight size={12} /><span className="fs-tiny">详情</span>
                      </button>
                      {active ? (
                        <button className="btn btn-danger !py-1 !px-2" onClick={() => cancel(s)}>
                          <XOctagon size={12} /><span className="fs-tiny">终止</span>
                        </button>
                      ) : (
                        <button className="btn btn-ghost !py-1 !px-2" onClick={() => rerun(s)}>
                          <RotateCw size={12} /><span className="fs-tiny">重跑</span>
                        </button>
                      )}
                      <button className="btn btn-danger !py-1 !px-2" onClick={() => setConfirmDel(s)}><Trash2 size={12} /></button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-3">
            <button className="btn btn-ghost !py-1" disabled={page <= 1} onClick={() => { const p = page - 1; setPage(p); void loadScans(p); }}>上一页</button>
            <span className="fs-tiny font-mono" style={{ color: '#8896a8' }}>{page} / {totalPages}</span>
            <button className="btn btn-ghost !py-1" disabled={page >= totalPages} onClick={() => { const p = page + 1; setPage(p); void loadScans(p); }}>下一页</button>
          </div>
        )}
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="下发侦察任务"
        wide
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setOpen(false)}>取消</button>
            <button className="btn btn-primary" disabled={busy} onClick={submit}>
              {busy ? '下发中…' : `下发 ${form.kinds.length} 个任务`}
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="授权目标" hint="只列出范围外的目标会拦截">
            <Select value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })}>
              <option value="">— 选择目标 —</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id} disabled={t.scope === 'out'}>
                  {t.name || t.value} ({t.value}){t.scope === 'out' ? ' · 范围外' : ''}
                </option>
              ))}
            </Select>
          </Field>

          {targets.length === 0 && (
            <div className="fs-tiny px-3 py-2 rounded" style={{ background: 'rgba(255,176,32,0.08)', border: '1px solid rgba(255,176,32,0.28)', color: '#ffd479' }}>
              还没有授权目标,先去「授权目标」登记一个。
            </div>
          )}

          <div>
            <label className="field-label">任务类型(可多选)</label>
            <div className="grid sm:grid-cols-2 gap-2">
              {(Object.keys(KIND_META) as ScanKind[]).map((k) => {
                const meta = KIND_META[k];
                const Icon = meta.icon;
                const checked = form.kinds.includes(k);
                return (
                  <button
                    key={k}
                    onClick={() => setForm({ ...form, kinds: checked ? form.kinds.filter((x) => x !== k) : [...form.kinds, k] })}
                    className="text-left p-2.5 rounded transition-colors"
                    style={{
                      background: checked ? 'rgba(34,227,160,0.09)' : 'rgba(255,255,255,0.02)',
                      border: `1px solid ${checked ? 'rgba(34,227,160,0.38)' : 'rgba(255,255,255,0.07)'}`,
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <Icon size={14} style={{ color: checked ? '#22e3a0' : '#5d6b7d' }} />
                      <span className="fs-small" style={{ color: checked ? '#eaf1f8' : '#8896a8' }}>{meta.label}</span>
                      {checked && <span className="chip ml-auto" style={{ color: '#22e3a0' }}>已选</span>}
                    </div>
                    <div className="fs-tiny mt-1" style={{ color: '#5d6b7d' }}>{meta.desc}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {form.kinds.includes('subdomain') && (
            <Field label="子域字典档位"><Select value={form.dict} onChange={(e) => setForm({ ...form, dict: e.target.value })}>{DICT_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></Field>
          )}
          {form.kinds.includes('port') && (
            <Field label="端口范围"><Select value={form.ports} onChange={(e) => setForm({ ...form, ports: e.target.value })}>{PORT_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></Field>
          )}
          {form.kinds.includes('dir') && (
            <Field label="目录字典档位"><Select value={form.dict} onChange={(e) => setForm({ ...form, dict: e.target.value })}>{DICT_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></Field>
          )}

          {form.kinds.includes('vuln') && (
            <div>
              <label className="field-label">检测项</label>
              <div className="flex flex-wrap gap-1.5">
                {VULN_CHECKS.map((c) => {
                  const checked = form.checks.includes(c.key);
                  return (
                    <button
                      key={c.key}
                      className="chip"
                      style={{ color: checked ? '#22e3a0' : '#5d6b7d', borderColor: checked ? 'rgba(34,227,160,0.35)' : 'rgba(255,255,255,0.08)', background: checked ? 'rgba(34,227,160,0.08)' : 'transparent' }}
                      onClick={() => setForm({ ...form, checks: checked ? form.checks.filter((x) => x !== c.key) : [...form.checks, c.key] })}
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {form.kinds.includes('poc') && (
            <div>
              <label className="field-label">选择 POC({form.pocIds.length} 个已选)</label>
              {pocs.length === 0 ? (
                <div className="fs-tiny" style={{ color: '#5d6b7d' }}>POC 库还是空的,先到「POC 库」里加几条。</div>
              ) : (
                <div className="flex flex-col gap-1 max-h-44 overflow-y-auto pr-1">
                  {pocs.map((p) => {
                    const checked = form.pocIds.includes(p.id);
                    return (
                      <button
                        key={p.id}
                        className="flex items-center gap-2 px-2.5 py-1.5 rounded text-left"
                        style={{ background: checked ? 'rgba(34,227,160,0.08)' : 'transparent', border: `1px solid ${checked ? 'rgba(34,227,160,0.3)' : 'transparent'}` }}
                        onClick={() => setForm({ ...form, pocIds: checked ? form.pocIds.filter((x) => x !== p.id) : [...form.pocIds, p.id] })}
                      >
                        <span className="fs-small truncate flex-1" style={{ color: checked ? '#eaf1f8' : '#8896a8' }}>{p.name}</span>
                        <span className="chip shrink-0">{p.severity}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <div className="grid sm:grid-cols-3 gap-4">
            <Field label="并发数"><TextInput type="number" min={1} max={200} value={form.concurrency} onChange={(e) => setForm({ ...form, concurrency: Number(e.target.value) || 20 })} /></Field>
            <Field label="超时(秒)"><TextInput type="number" min={1} max={60} value={form.timeout} onChange={(e) => setForm({ ...form, timeout: Number(e.target.value) || 8 })} /></Field>
            <Field label="跟随跳转">
              <Select value={form.followRedirect ? '1' : '0'} onChange={(e) => setForm({ ...form, followRedirect: e.target.value === '1' })}>
                <option value="1">是</option><option value="0">否</option>
              </Select>
            </Field>
          </div>

          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 fs-small" style={{ color: '#8896a8' }}>
              <input type="checkbox" checked={form.useExternal} onChange={(e) => setForm({ ...form, useExternal: e.target.checked })} />
              优先调用本机已装的外部工具(nmap / nuclei / subfinder 等)
            </label>
            <label className="flex items-center gap-2 fs-small" style={{ color: '#8896a8' }}>
              <input type="checkbox" checked={form.safeMode} onChange={(e) => setForm({ ...form, safeMode: e.target.checked })} />
              安全模式(限速、不做破坏性请求)
            </label>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!confirmDel}
        onClose={() => setConfirmDel(null)}
        title="删除任务"
        footer={<><button className="btn btn-ghost" onClick={() => setConfirmDel(null)}>取消</button><button className="btn btn-danger" onClick={remove}>确认删除</button></>}
      >
        <p className="fs-small" style={{ color: '#c9d4e0' }}>删除任务「{confirmDel?.name}」?该任务的运行日志会一起删掉,已产出的资产与发现会保留。</p>
      </Modal>
    </div>
  );
}
