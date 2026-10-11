import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ruler, Plus, Save, Trash2, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  allRecords, createRecord, deleteRecord, updateRecord, type RubricRecord,
} from '../lib/api';
import { EmptyState, Modal, Spinner, TextArea, TextInput, notify, fmtRelative } from '../components/kit';

/** 判定准则表：两边（ReconLab / PhantomVeil 插件）共用的判定门槛，改完立刻生效 */

type Draft = {
  rule_id: string;
  title: string;
  category: string;
  enforce: boolean;
  min_confidence: number;
  confirm_checks: string;
  confirm_evidence_kinds: string;
  reject_reasons: string;
  inconclusive_triggers: string;
  note: string;
  enabled: boolean;
};

const CHECK_IDS = ['reproduce', 'control', 'cross', 'active', 'side', 'waf'];

function toList(value?: string[] | string): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return String(value).split(',').map((s) => s.trim()).filter(Boolean);
  }
}

function toDraft(record: RubricRecord): Draft {
  return {
    rule_id: record.rule_id || '',
    title: record.title || '',
    category: record.category || '',
    enforce: !!record.enforce,
    min_confidence: Number(record.min_confidence || 0),
    confirm_checks: toList(record.confirm_checks).join(', '),
    confirm_evidence_kinds: toList(record.confirm_evidence_kinds).join(', '),
    reject_reasons: toList(record.reject_reasons).join(', '),
    inconclusive_triggers: toList(record.inconclusive_triggers).join(', '),
    note: record.note || '',
    enabled: record.enabled !== false,
  };
}

function splitList(text: string): string[] {
  return text.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
}

function payloadOf(draft: Draft) {
  return {
    rule_id: draft.rule_id.trim(),
    title: draft.title.trim(),
    category: draft.category.trim(),
    enforce: draft.enforce,
    min_confidence: Number(draft.min_confidence) || 0,
    confirm_checks: splitList(draft.confirm_checks),
    confirm_evidence_kinds: splitList(draft.confirm_evidence_kinds),
    reject_reasons: splitList(draft.reject_reasons),
    inconclusive_triggers: splitList(draft.inconclusive_triggers),
    note: draft.note,
    enabled: draft.enabled,
  };
}

export function RubricsPage() {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<RubricRecord[]>([]);
  const [editing, setEditing] = useState<RubricRecord | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const list = await allRecords<RubricRecord>('decision_rubrics', { sort: 'rule_id', perPage: 200 }, 300)
      .catch(() => [] as RubricRecord[]);
    setRows(list);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openEdit = (record: RubricRecord) => {
    setEditing(record);
    setDraft(toDraft(record));
    setCreating(false);
  };

  const openCreate = () => {
    setEditing(null);
    setCreating(true);
    setDraft({
      rule_id: '', title: '', category: '', enforce: false, min_confidence: 50,
      confirm_checks: 'reproduce', confirm_evidence_kinds: '', reject_reasons: '',
      inconclusive_triggers: 'timeout, blocked_by_waf, not_delivered', note: '', enabled: true,
    });
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.rule_id.trim() && creating) { notify('rule_id 必填（对齐 PhantomVeil 插件的 kind）', 'err'); return; }
    setBusy(true);
    try {
      if (creating) {
        await createRecord('decision_rubrics', payloadOf(draft));
        notify('判定准则已新增，两边立刻按新门槛走', 'ok');
      } else if (editing) {
        const { rule_id, ...rest } = payloadOf(draft);
        void rule_id;
        await updateRecord('decision_rubrics', editing.id, rest);
        notify('判定准则已更新', 'ok');
      }
      setEditing(null);
      setDraft(null);
      setCreating(false);
      await load();
    } catch (err) {
      notify(err instanceof Error ? err.message : '保存失败', 'err');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (record: RubricRecord) => {
    try {
      await deleteRecord('decision_rubrics', record.id);
      notify('已删除该准则（该 kind 会落到 default 兜底）', 'ok');
      await load();
    } catch { notify('删除失败', 'err'); }
  };

  const strictCount = useMemo(() => rows.filter((r) => r.enforce).length, [rows]);

  if (loading) return <div className="grid place-items-center py-24"><Spinner label="正在读取判定准则…" /></div>;

  return (
    <div className="flex flex-col gap-3">
      <div className="hud-panel p-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Ruler size={15} className="text-[var(--accent)]" />
          <span className="title-sm">判定准则表</span>
          <span className="chip chip-accent">enforce 硬拦 {strictCount} 条</span>
          <span className="chip">{rows.length} 条规则</span>
          <div className="ml-auto flex items-center gap-1.5">
            <button className="btn btn-ghost" onClick={() => void load()}><RefreshCw size={13} />刷新</button>
            <button className="btn btn-primary" onClick={openCreate}><Plus size={13} />新增准则</button>
          </div>
        </div>
        <p className="dim text-xs mt-2" style={{ lineHeight: 1.7 }}>
          「打过去没反应算 rejected 还是 inconclusive」这类判断不再靠人记，全部落成结构化字段：
          两边共用同一张表，PhantomVeil 的验证插件照这张表写门槛，
          <b>enforce</b> 打开的规则会被服务端硬拦（422 RUBRIC_VIOLATION），
          没打开的只回 warning 不挡写入。改完保存即刻生效。
        </p>
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={<Ruler size={26} />} title="还没有判定准则"
          desc="跑一次 scripts/upgrade_contract_v2.py 会灌入内置的 11 条默认准则。"
          action={<button className="btn btn-primary" onClick={openCreate}><Plus size={13} />手写一条</button>} />
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <div key={row.id} className="hud-panel p-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="mono text-sm" style={{ color: 'var(--accent)' }}>{row.rule_id}</span>
                <span className="text-sm">{row.title}</span>
                {row.category && <span className="chip">{row.category}</span>}
                <span className={`chip ${row.enforce ? 'chip-accent' : ''}`}>
                  {row.enforce ? 'enforce 硬拦' : '仅告警'}
                </span>
                {row.enabled === false && <span className="chip chip-warn">已停用</span>}
                <span className="chip">门槛 {row.min_confidence ?? 0}</span>
                <span className="dim text-xs ml-auto">{fmtRelative(row.updated)}</span>
                <button className="btn btn-ghost" onClick={() => openEdit(row)}><ShieldCheck size={13} />编辑</button>
                <button className="btn btn-ghost" onClick={() => void remove(row)}><Trash2 size={13} /></button>
              </div>
              <div className="flex flex-wrap gap-3 mt-2 text-xs dim">
                <span>确认检查项：<span className="mono">{toList(row.confirm_checks).join(' + ') || '—'}</span></span>
                <span>否定原因：<span className="mono">{toList(row.reject_reasons).slice(0, 5).join('/') || '—'}</span></span>
                <span>无法判定触发：<span className="mono">{toList(row.inconclusive_triggers).slice(0, 4).join('/') || '—'}</span></span>
              </div>
              {row.note && <div className="text-xs mt-2" style={{ lineHeight: 1.7 }}>{row.note}</div>}
            </div>
          ))}
        </div>
      )}

      <Modal
        open={!!draft}
        onClose={() => { setDraft(null); setEditing(null); setCreating(false); }}
        title={creating ? '新增判定准则' : `编辑准则 · ${editing?.rule_id || ''}`}
        wide
        footer={
          <div className="flex justify-end gap-2">
            <button className="btn btn-ghost" onClick={() => { setDraft(null); setEditing(null); setCreating(false); }}>取消</button>
            <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>
              {busy ? '保存中…' : <><Save size={13} />保存</>}
            </button>
          </div>
        }
      >
        {draft && (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className="label">kind（rule_id）</span>
                <TextInput value={draft.rule_id} disabled={!creating}
                  placeholder="open_redirect"
                  onChange={(e) => setDraft({ ...draft, rule_id: e.target.value })} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="label">显示名</span>
                <TextInput value={draft.title} placeholder="开放重定向"
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="label">分类</span>
                <TextInput value={draft.category} placeholder="A01 访问控制"
                  onChange={(e) => setDraft({ ...draft, category: e.target.value })} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="label">置信度门槛</span>
                <TextInput type="number" min={0} max={100} value={draft.min_confidence}
                  onChange={(e) => setDraft({ ...draft, min_confidence: Number(e.target.value) })} />
              </label>
            </div>

            <label className="flex flex-col gap-1">
              <span className="label">确认必须通过的检查项（逗号分隔，可选：{CHECK_IDS.join(' / ')}）</span>
              <TextInput value={draft.confirm_checks}
                onChange={(e) => setDraft({ ...draft, confirm_checks: e.target.value })} />
            </label>

            <label className="flex flex-col gap-1">
              <span className="label">确认可用的证据类型（留空 = 不限）</span>
              <TextInput value={draft.confirm_evidence_kinds} placeholder="http_exchange, timing_sample"
                onChange={(e) => setDraft({ ...draft, confirm_evidence_kinds: e.target.value })} />
            </label>

            <label className="flex flex-col gap-1">
              <span className="label">否定原因词表（rejected 的 reason_code 取值）</span>
              <TextInput value={draft.reject_reasons} placeholder="encoded, escaped, no_diff"
                onChange={(e) => setDraft({ ...draft, reject_reasons: e.target.value })} />
            </label>

            <label className="flex flex-col gap-1">
              <span className="label">无法判定触发词表（inconclusive 的 reason_code 取值）</span>
              <TextInput value={draft.inconclusive_triggers} placeholder="timeout, blocked_by_waf"
                onChange={(e) => setDraft({ ...draft, inconclusive_triggers: e.target.value })} />
            </label>

            <label className="flex flex-col gap-1">
              <span className="label">判据说明（给人看的门槛解释，会随响应回给 Agent）</span>
              <TextArea rows={5} value={draft.note}
                onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
            </label>

            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={draft.enforce}
                  onChange={(e) => setDraft({ ...draft, enforce: e.target.checked })} />
                违反即硬拦（422 RUBRIC_VIOLATION）
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={draft.enabled}
                  onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
                启用
              </label>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
