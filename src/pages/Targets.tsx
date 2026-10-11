import { useEffect, useMemo, useState } from 'react';
import { Crosshair, Plus, Search, Trash2, Pencil, Play, Globe, Server, Link2, Network } from 'lucide-react';
import { createRecord, deleteRecord, allRecords, updateRecord, type Target } from '../lib/api';
import { navigate } from '../lib/router';
import { EmptyState, Field, Modal, Select, Spinner, TextArea, TextInput, notify } from '../components/kit';

const KIND_ICON: Record<string, typeof Globe> = { domain: Globe, ip: Server, url: Link2, cidr: Network };
const KIND_LABEL: Record<string, string> = { domain: '域名', ip: 'IP', url: 'URL', cidr: '网段' };

const emptyForm = { name: '', value: '', kind: 'domain', scope: 'in', tags: '', note: '' };

export function TargetsPage() {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<Target[]>([]);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Target | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ ...emptyForm });
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState<Target | null>(null);

  const load = async () => {
    try {
      const list = await allRecords<Target>('targets', { sort: '-created', perPage: 100 }, 400);
      setItems(list);
    } catch (e) {
      notify(e instanceof Error ? e.message : '加载失败', 'err');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const filtered = useMemo(() => {
    const key = q.trim().toLowerCase();
    if (!key) return items;
    return items.filter((t) =>
      [t.name, t.value, t.tags, t.note].filter(Boolean).some((v) => String(v).toLowerCase().includes(key)),
    );
  }, [items, q]);

  const openCreate = () => { setEditing(null); setForm({ ...emptyForm }); setOpen(true); };
  const openEdit = (t: Target) => {
    setEditing(t);
    setForm({ name: t.name || '', value: t.value || '', kind: t.kind || 'domain', scope: t.scope || 'in', tags: t.tags || '', note: t.note || '' });
    setOpen(true);
  };

  const save = async () => {
    if (!form.value.trim()) { notify('目标值不能为空', 'err'); return; }
    setBusy(true);
    try {
      const payload = { ...form, name: form.name.trim() || form.value.trim() };
      if (editing) {
        const updated = await updateRecord<Target>('targets', editing.id, payload);
        setItems((prev) => prev.map((x) => (x.id === editing.id ? updated : x)));
        notify('目标已更新', 'ok');
      } else {
        const created = await createRecord<Target>('targets', payload);
        setItems((prev) => [created, ...prev]);
        notify('目标已登记', 'ok');
      }
      setOpen(false);
    } catch (e) {
      notify(e instanceof Error ? e.message : '保存失败', 'err');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirmDel) return;
    try {
      await deleteRecord('targets', confirmDel.id);
      setItems((prev) => prev.filter((x) => x.id !== confirmDel.id));
      notify('已删除', 'ok');
    } catch (e) {
      notify(e instanceof Error ? e.message : '删除失败', 'err');
    } finally {
      setConfirmDel(null);
    }
  };

  if (loading) return <Spinner label="正在拉取授权目标…" />;

  return (
    <div className="section-wrap">
      <div className="container-fluid flex flex-col" style={{ gap: 'var(--gap-fluid)' }}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[180px]">
            <Search size={14} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: '#4a5768' }} />
            <TextInput placeholder="搜索目标 / 标签…" value={q} onChange={(e) => setQ(e.target.value)} style={{ paddingLeft: 28 }} />
          </div>
          <button className="btn btn-primary" onClick={openCreate}><Plus size={14} />登记目标</button>
        </div>

        <div className="fs-tiny" style={{ color: '#5d6b7d' }}>
          共 {items.length} 个目标 · 在范围 {items.filter((t) => t.scope === 'in').length} 个 · 范围外的目标不会被下发任务
        </div>

        {filtered.length === 0 ? (
          <div className="hud-panel">
            <EmptyState
              icon={<Crosshair size={30} />}
              title={items.length ? '没有匹配的目标' : '还没有登记目标'}
              desc={items.length ? '换个关键词试试' : '把允许测试的域名 / IP / 网段登记进来,顺便标好哪些在授权范围内。'}
              action={<button className="btn btn-primary mt-2" onClick={openCreate}><Plus size={14} />登记第一个目标</button>}
            />
          </div>
        ) : (
          <div className="grid-auto">
            {filtered.map((t) => {
              const Icon = KIND_ICON[t.kind] || Globe;
              const inScope = t.scope === 'in';
              return (
                <div key={t.id} className="hud-panel hud-panel-hover p-3.5 flex flex-col gap-2.5 min-w-0">
                  <div className="flex items-start gap-2.5 min-w-0">
                    <div className="grid place-items-center shrink-0" style={{ width: 32, height: 32, borderRadius: 5, background: 'rgba(34,227,160,0.09)', border: '1px solid rgba(34,227,160,0.26)', color: '#22e3a0' }}>
                      <Icon size={16} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="fs-small font-medium truncate" style={{ color: '#eaf1f8' }}>{t.name || t.value}</div>
                      <div className="fs-tiny font-mono truncate" style={{ color: '#8896a8' }}>{t.value}</div>
                    </div>
                    <span className="chip shrink-0" style={{ color: inScope ? '#22e3a0' : '#ff8a3d', borderColor: inScope ? 'rgba(34,227,160,0.3)' : 'rgba(255,138,61,0.3)' }}>
                      {inScope ? '范围内' : '范围外'}
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    <span className="chip">{KIND_LABEL[t.kind] || t.kind}</span>
                    {t.tags ? t.tags.split(',').filter(Boolean).map((tag) => (
                      <span key={tag} className="chip" style={{ color: '#4cc9f0', borderColor: 'rgba(76,201,240,0.28)' }}>{tag.trim()}</span>
                    )) : null}
                  </div>

                  {t.note && <div className="fs-tiny" style={{ color: '#5d6b7d' }}>{t.note}</div>}

                  <div className="flex flex-wrap items-center gap-1.5 mt-auto pt-1">
                    <button className="btn btn-ghost !py-1 !px-2" disabled={!inScope} onClick={() => navigate(`/scans?target=${t.id}`)}>
                      <Play size={12} /><span className="fs-tiny">下发任务</span>
                    </button>
                    <button className="btn btn-ghost !py-1 !px-2" onClick={() => openEdit(t)}><Pencil size={12} /><span className="fs-tiny">编辑</span></button>
                    <button className="btn btn-danger !py-1 !px-2 ml-auto" onClick={() => setConfirmDel(t)}><Trash2 size={12} /></button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? '编辑目标' : '登记授权目标'}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setOpen(false)}>取消</button>
            <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存'}</button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="名称" hint="方便自己认,留空就用目标值">
            <TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="公司主站" />
          </Field>
          <Field label="目标值">
            <TextInput value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} placeholder="example.com / 10.0.0.0/24 / https://app.example.com" />
          </Field>
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="类型">
              <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                <option value="domain">域名</option>
                <option value="ip">IP 地址</option>
                <option value="url">URL</option>
                <option value="cidr">网段</option>
              </Select>
            </Field>
            <Field label="授权范围">
              <Select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })}>
                <option value="in">在范围内(可下发任务)</option>
                <option value="out">范围外(仅登记)</option>
              </Select>
            </Field>
          </div>
          <Field label="标签" hint="英文逗号分隔,如:生产,主站">
            <TextInput value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="生产,主站" />
          </Field>
          <Field label="备注" hint="授权依据 / 联系人 / 注意事项">
            <TextArea rows={3} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="授权书编号 SOW-2025-xxx,测试窗口 22:00-06:00" />
          </Field>
        </div>
      </Modal>

      <Modal
        open={!!confirmDel}
        onClose={() => setConfirmDel(null)}
        title="删除目标"
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setConfirmDel(null)}>取消</button>
            <button className="btn btn-danger" onClick={remove}>确认删除</button>
          </>
        }
      >
        <p className="fs-small" style={{ color: '#c9d4e0' }}>
          确定删除「{confirmDel?.name || confirmDel?.value}」?历史任务和结果会保留。
        </p>
      </Modal>
    </div>
  );
}
