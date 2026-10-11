import { useEffect, useMemo, useState } from 'react';
import { FlaskConical, Plus, Trash2, Pencil, Play, Sparkles, ChevronDown, ChevronUp } from 'lucide-react';
import { allRecords, createRecord, deleteRecord, updateRecord, type Poc, type ScanKind, type Severity, type Target } from '../lib/api';
import { EmptyState, Field, Modal, Select, SeverityBadge, Spinner, TextArea, TextInput, notify } from '../components/kit';

const emptyPoc = {
  name: '', category: '未授权访问', severity: 'high' as Severity, description: '',
  method: 'GET', path: '/', headers: '{\n  "User-Agent": "Mozilla/5.0"\n}', body: '',
  matchers: '{\n  "status": [200],\n  "contains": ["example"]\n}', enabled: true,
};

const BUILTIN_POCS: Array<Partial<Poc>> = [
  {
    name: 'Git 目录泄露', category: '敏感文件', severity: 'high', method: 'GET', path: '/.git/config',
    description: '源码版本库目录未做访问控制,可下载源码与凭据。',
    matchers: '{"status":[200],"contains":["[core]","repositoryformatversion"]}',
  },
  {
    name: '环境变量文件泄露', category: '敏感文件', severity: 'critical', method: 'GET', path: '/.env',
    description: '环境变量文件可公开访问,通常包含数据库密码与密钥。',
    matchers: '{"status":[200],"regex":["(?i)(DB_|APP_KEY|SECRET|PASSWORD)"]}',
  },
  {
    name: 'Spring Actuator 暴露', category: '未授权访问', severity: 'high', method: 'GET', path: '/actuator/env',
    description: 'Actuator 端点未授权可读,可能泄露配置与凭据。',
    matchers: '{"status":[200],"contains":["activeProfiles","propertySources"]}',
  },
  {
    name: 'Swagger 接口文档暴露', category: '信息泄露', severity: 'medium', method: 'GET', path: '/swagger-ui/index.html',
    description: '接口文档对外开放,便于攻击者枚举业务接口。',
    matchers: '{"status":[200],"contains":["swagger"]}',
  },
  {
    name: '备份文件可下载', category: '敏感文件', severity: 'high', method: 'GET', path: '/www.zip',
    description: '站点备份压缩包可直接下载。',
    matchers: '{"status":[200],"header":{"Content-Type":"application/(zip|octet-stream)"}}',
  },
  {
    name: 'phpMyAdmin 面板暴露', category: '未授权访问', severity: 'medium', method: 'GET', path: '/phpmyadmin/',
    description: '数据库管理面板对外可达,存在弱口令爆破风险。',
    matchers: '{"status":[200],"contains":["phpMyAdmin"]}',
  },
];

export function PocsPage() {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<Poc[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Poc | null>(null);
  const [form, setForm] = useState({ ...emptyPoc });
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [runTarget, setRunTarget] = useState('');
  const [runIds, setRunIds] = useState<string[]>([]);

  const load = async () => {
    try {
      const list = await allRecords<Poc>('pocs', { sort: '-created', perPage: 100 }, 400);
      setItems(list);
      return list;
    } catch (e) {
      notify(e instanceof Error ? e.message : '加载失败', 'err');
      return [];
    }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      await load();
      const tList = await allRecords<Target>('targets', { perPage: 100, fields: 'id,name,value,scope' }, 300).catch(() => [] as Target[]);
      if (!alive) return;
      setTargets(tList);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, []);

  const groups = useMemo(() => {
    const map = new Map<string, Poc[]>();
    for (const p of items) {
      const key = p.category || '未分类';
      map.set(key, [...(map.get(key) || []), p]);
    }
    return Array.from(map.entries());
  }, [items]);

  const save = async () => {
    if (!form.name.trim()) { notify('POC 名称不能为空', 'err'); return; }
    setBusy(true);
    try {
      const payload = { ...form, enabled: !!form.enabled };
      if (editing) {
        const updated = await updateRecord<Poc>('pocs', editing.id, payload);
        setItems((prev) => prev.map((x) => (x.id === editing.id ? updated : x)));
        notify('已更新', 'ok');
      } else {
        const created = await createRecord<Poc>('pocs', payload);
        setItems((prev) => [created, ...prev]);
        notify('已加入 POC 库', 'ok');
      }
      setOpen(false);
    } catch (e) {
      notify(e instanceof Error ? e.message : '保存失败', 'err');
    } finally {
      setBusy(false);
    }
  };

  const importBuiltin = async () => {
    setBusy(true);
    try {
      const existing = new Set(items.map((p) => p.name));
      const toAdd = BUILTIN_POCS.filter((p) => p.name && !existing.has(p.name));
      let added = 0;
      for (const p of toAdd) {
        await createRecord<Poc>('pocs', {
          name: p.name, category: p.category, severity: p.severity, method: p.method,
          path: p.path, description: p.description,
          headers: '{"User-Agent":"Mozilla/5.0"}', body: '', matchers: p.matchers, enabled: true,
        });
        added += 1;
      }
      await load();
      notify(added ? `已导入 ${added} 条内置 POC` : '内置 POC 都已经有了', added ? 'ok' : 'info');
    } catch (e) {
      notify(e instanceof Error ? e.message : '导入失败', 'err');
    } finally {
      setBusy(false);
    }
  };

  const launchVerify = async () => {
    if (!runTarget) { notify('选一个目标', 'err'); return; }
    if (runIds.length === 0) { notify('至少勾一条 POC', 'err'); return; }
    const tgt = targets.find((t) => t.id === runTarget);
    if (tgt && tgt.scope === 'out') { notify('该目标在授权范围外', 'err'); return; }
    setBusy(true);
    try {
      await createRecord('scans', {
        name: `${tgt?.name || '目标'} · POC 批量验证`,
        kind: 'poc' as ScanKind,
        target: runTarget,
        args: JSON.stringify({ poc_ids: runIds, concurrency: 10, timeout: 8, safe_mode: true, use_external: true }),
        status: 'queued', progress: 0, message: `待验证 ${runIds.length} 条 POC`,
      });
      notify('验证任务已下发,去「任务编排」看进度', 'ok');
      setRunOpen(false);
      setRunIds([]);
    } catch (e) {
      notify(e instanceof Error ? e.message : '下发失败', 'err');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Spinner label="正在拉取 POC 库…" />;

  return (
    <div className="section-wrap">
      <div className="container-fluid flex flex-col" style={{ gap: 'var(--gap-fluid)' }}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="fs-small flex-1" style={{ color: '#8896a8' }}>共 {items.length} 条 POC,按分类归组</span>
          <button className="btn btn-ghost" disabled={busy} onClick={importBuiltin}><Sparkles size={14} />导入内置模板</button>
          <button className="btn btn-accent" onClick={() => { setRunIds(items.filter((p) => p.enabled).map((p) => p.id).slice(0, 20)); setRunOpen(true); }}>
            <Play size={14} />批量验证
          </button>
          <button className="btn btn-primary" onClick={() => { setEditing(null); setForm({ ...emptyPoc }); setOpen(true); }}>
            <Plus size={14} />新建 POC
          </button>
        </div>

        {items.length === 0 ? (
          <div className="hud-panel">
            <EmptyState
              icon={<FlaskConical size={30} />}
              title="POC 库还是空的"
              desc="可以先导入内置模板(未授权访问 / 敏感文件 / 接口暴露),再按自己的目标补充。"
              action={<button className="btn btn-primary mt-2" disabled={busy} onClick={importBuiltin}><Sparkles size={14} />导入内置模板</button>}
            />
          </div>
        ) : (
          groups.map(([category, list]) => (
            <div key={category} className="flex flex-col gap-2">
              <div className="fs-tiny uppercase tracking-widest" style={{ color: '#5d6b7d', fontFamily: "'Chakra Petch',sans-serif" }}>
                {category} · {list.length}
              </div>
              <div className="grid-auto">
                {list.map((p) => {
                  const isOpen = expanded === p.id;
                  return (
                    <div key={p.id} className="hud-panel hud-panel-hover p-3.5 flex flex-col gap-2 min-w-0">
                      <div className="flex items-start gap-2 min-w-0">
                        <div className="min-w-0 flex-1">
                          <div className="fs-small font-medium truncate" style={{ color: '#eaf1f8' }}>{p.name}</div>
                          <div className="fs-tiny font-mono truncate mt-0.5" style={{ color: '#4cc9f0' }}>{p.method || 'GET'} {p.path || '/'}</div>
                        </div>
                        <SeverityBadge severity={p.severity} />
                      </div>

                      {p.description && <div className="fs-tiny" style={{ color: '#5d6b7d' }}>{p.description}</div>}

                      <button className="fs-tiny flex items-center gap-1 self-start" style={{ color: '#8896a8' }} onClick={() => setExpanded(isOpen ? null : p.id)}>
                        {isOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}匹配规则
                      </button>
                      {isOpen && (
                        <div className="terminal" style={{ maxHeight: 160 }}>{p.matchers || '{}'}</div>
                      )}

                      <div className="flex items-center gap-1.5 mt-auto pt-1">
                        <span className="chip" style={{ color: p.enabled ? '#22e3a0' : '#5d6b7d' }}>{p.enabled ? '已启用' : '已停用'}</span>
                        <button
                          className="btn btn-ghost !py-1 !px-2"
                          onClick={async () => {
                            try {
                              const updated = await updateRecord<Poc>('pocs', p.id, { enabled: !p.enabled });
                              setItems((prev) => prev.map((x) => (x.id === p.id ? updated : x)));
                            } catch (e) { notify(e instanceof Error ? e.message : '操作失败', 'err'); }
                          }}
                        >
                          <span className="fs-tiny">{p.enabled ? '停用' : '启用'}</span>
                        </button>
                        <button className="btn btn-ghost !py-1 !px-2" onClick={() => { setEditing(p); setForm({ ...emptyPoc, ...p }); setOpen(true); }}>
                          <Pencil size={12} />
                        </button>
                        <button
                          className="btn btn-danger !py-1 !px-2 ml-auto"
                          onClick={async () => {
                            try {
                              await deleteRecord('pocs', p.id);
                              setItems((prev) => prev.filter((x) => x.id !== p.id));
                              notify('已删除', 'ok');
                            } catch (e) { notify(e instanceof Error ? e.message : '删除失败', 'err'); }
                          }}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>

      {/* 新建/编辑 */}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? '编辑 POC' : '新建 POC'}
        wide
        footer={<><button className="btn btn-ghost" onClick={() => setOpen(false)}>取消</button><button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存'}</button></>}
      >
        <div className="flex flex-col gap-4">
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="名称"><TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Git 目录泄露" /></Field>
            <Field label="分类"><TextInput value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="敏感文件" /></Field>
          </div>
          <div className="grid sm:grid-cols-3 gap-4">
            <Field label="等级">
              <Select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value as Severity })}>
                <option value="critical">严重</option><option value="high">高危</option><option value="medium">中危</option><option value="low">低危</option><option value="info">信息</option>
              </Select>
            </Field>
            <Field label="方法">
              <Select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
                {['GET', 'POST', 'PUT', 'HEAD', 'OPTIONS'].map((m) => <option key={m} value={m}>{m}</option>)}
              </Select>
            </Field>
            <Field label="路径"><TextInput value={form.path} onChange={(e) => setForm({ ...form, path: e.target.value })} placeholder="/.git/config" /></Field>
          </div>
          <Field label="说明"><TextArea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="这条 POC 检测什么问题" /></Field>
          <Field label="请求头 (JSON)">
            <TextArea rows={4} value={form.headers} onChange={(e) => setForm({ ...form, headers: e.target.value })} />
          </Field>
          <Field label="请求体" hint="POST 时使用,支持 {{param}} 占位">
            <TextArea rows={3} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
          </Field>
          <Field label="匹配规则 (JSON)" hint='支持 status / contains / not_contains / regex / header,例如 {"status":[200],"contains":["[core]"]}'>
            <TextArea rows={5} value={form.matchers} onChange={(e) => setForm({ ...form, matchers: e.target.value })} />
          </Field>
          <label className="flex items-center gap-2 fs-small" style={{ color: '#8896a8' }}>
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />启用这条 POC
          </label>
        </div>
      </Modal>

      {/* 批量验证 */}
      <Modal
        open={runOpen}
        onClose={() => setRunOpen(false)}
        title="批量验证 POC"
        wide
        footer={<><button className="btn btn-ghost" onClick={() => setRunOpen(false)}>取消</button><button className="btn btn-primary" disabled={busy} onClick={launchVerify}>{busy ? '下发中…' : `对 ${runIds.length} 条 POC 发起验证`}</button></>}
      >
        <div className="flex flex-col gap-4">
          <Field label="目标">
            <Select value={runTarget} onChange={(e) => setRunTarget(e.target.value)}>
              <option value="">— 选择目标 —</option>
              {targets.map((t) => <option key={t.id} value={t.id} disabled={t.scope === 'out'}>{t.name || t.value} ({t.value})</option>)}
            </Select>
          </Field>
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="field-label !mb-0">选择 POC({runIds.length} 条)</span>
              <button className="fs-tiny ml-auto" style={{ color: '#22e3a0' }} onClick={() => setRunIds(items.filter((p) => p.enabled).map((p) => p.id))}>全选已启用</button>
              <button className="fs-tiny" style={{ color: '#8896a8' }} onClick={() => setRunIds([])}>清空</button>
            </div>
            <div className="flex flex-col gap-1 max-h-64 overflow-y-auto pr-1">
              {items.map((p) => {
                const checked = runIds.includes(p.id);
                return (
                  <button
                    key={p.id}
                    className="flex items-center gap-2 px-2.5 py-1.5 rounded text-left"
                    style={{ background: checked ? 'rgba(34,227,160,0.08)' : 'transparent', border: `1px solid ${checked ? 'rgba(34,227,160,0.3)' : 'transparent'}` }}
                    onClick={() => setRunIds(checked ? runIds.filter((x) => x !== p.id) : [...runIds, p.id])}
                  >
                    <span className="fs-small truncate flex-1 min-w-0" style={{ color: checked ? '#eaf1f8' : '#8896a8' }}>{p.name}</span>
                    <span className="fs-tiny font-mono shrink-0" style={{ color: '#5d6b7d' }}>{p.path}</span>
                    <SeverityBadge severity={p.severity} />
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
