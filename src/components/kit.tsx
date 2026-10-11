import { useEffect, useRef, useState, type ReactNode, type InputHTMLAttributes, type TextareaHTMLAttributes, type SelectHTMLAttributes } from 'react';
import { X, Check, Copy, Loader2, AlertTriangle, Info, CheckCircle2, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Severity, FindingStatus, ScanStatus } from '../lib/api';

/* ───────────── 严重度 ───────────── */
export const SEVERITY_META: Record<Severity, { label: string; color: string; bg: string; border: string }> = {
  critical: { label: '严重', color: '#ff2b3d', bg: 'rgba(255,43,61,0.13)', border: 'rgba(255,43,61,0.45)' },
  high: { label: '高危', color: '#ff6b3d', bg: 'rgba(255,107,61,0.12)', border: 'rgba(255,107,61,0.4)' },
  medium: { label: '中危', color: '#ffb000', bg: 'rgba(255,176,0,0.12)', border: 'rgba(255,176,0,0.38)' },
  low: { label: '低危', color: '#38d9ff', bg: 'rgba(56,217,255,0.1)', border: 'rgba(56,217,255,0.34)' },
  info: { label: '信息', color: '#6b8b7c', bg: 'rgba(107,139,124,0.12)', border: 'rgba(107,139,124,0.34)' },
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  const m = SEVERITY_META[severity] ?? SEVERITY_META.info;
  return (
    <span
      className="chip"
      style={{ color: m.color, background: m.bg, borderColor: m.border, fontWeight: 600 }}
    >
      {m.label}
    </span>
  );
}

const SCAN_STATUS: Record<ScanStatus, { label: string; color: string }> = {
  queued: { label: '排队中', color: '#6b8b7c' },
  running: { label: '执行中', color: '#00ff88' },
  done: { label: '已完成', color: '#38d9ff' },
  failed: { label: '失败', color: '#ff2b3d' },
  canceled: { label: '已取消', color: '#7d9b8a' },
};

export function StatusChip({ status }: { status: ScanStatus }) {
  const m = SCAN_STATUS[status] ?? SCAN_STATUS.queued;
  return (
    <span className="chip" style={{ color: m.color, borderColor: 'rgba(255,255,255,0.1)' }}>
      <span
        className={status === 'running' ? 'animate-glow-pulse' : ''}
        style={{ width: 6, height: 6, borderRadius: 999, background: m.color, display: 'inline-block' }}
      />
      {m.label}
    </span>
  );
}

const FINDING_STATUS: Record<FindingStatus, { label: string; color: string }> = {
  new: { label: '待验证', color: '#ffb000' },
  confirmed: { label: '已确认', color: '#00ff88' },
  false_positive: { label: '误报', color: '#6b8b7c' },
  fixed: { label: '已修复', color: '#38d9ff' },
};

export function FindingStatusChip({ status }: { status: FindingStatus }) {
  const m = FINDING_STATUS[status] ?? FINDING_STATUS.new;
  return <span className="chip" style={{ color: m.color, borderColor: 'rgba(255,255,255,0.1)' }}>{m.label}</span>;
}

/* ───────────── 统计卡 ───────────── */
export function StatCard({
  label, value, icon, hint, tone = 'primary',
}: {
  label: string; value: ReactNode; icon: ReactNode; hint?: string; tone?: 'primary' | 'accent' | 'danger' | 'plain';
}) {
  const toneColor = tone === 'accent' ? '#ffb020' : tone === 'danger' ? '#ff2d55' : tone === 'plain' ? '#8896a8' : '#22e3a0';
  return (
    <div className="hud-panel hud-panel-hover p-3 sm:p-4 flex items-start gap-3 min-w-0">
      <div
        className="shrink-0 grid place-items-center rounded"
        style={{ width: 38, height: 38, background: `${toneColor}1a`, border: `1px solid ${toneColor}40`, color: toneColor }}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="fs-tiny uppercase tracking-widest" style={{ color: '#5d6b7d', fontFamily: "'Chakra Petch',sans-serif" }}>{label}</div>
        <div className="fs-stat font-mono font-bold" style={{ color: '#e8fff3' }}>{value}</div>
        {hint && <div className="fs-tiny truncate" style={{ color: '#5d6b7d' }}>{hint}</div>}
      </div>
    </div>
  );
}

/* ───────────── 空状态 ───────────── */
export function EmptyState({ icon, title, desc, action }: { icon: ReactNode; title: string; desc?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-2 py-10 px-4">
      <div style={{ color: '#2b3a4a' }}>{icon}</div>
      <div className="fs-subheading" style={{ color: '#7d9b8a' }}>{title}</div>
      {desc && <div className="fs-small max-w-md" style={{ color: '#5d6b7d' }}>{desc}</div>}
      {action}
    </div>
  );
}

/* ───────────── 加载 ───────────── */
export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-8" style={{ color: '#5d6b7d' }}>
      <Loader2 size={16} className="animate-spin" />
      <span className="fs-small">{label || '加载中…'}</span>
    </div>
  );
}

export function InlineLoader({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 fs-tiny" style={{ color: '#5d6b7d' }}>
      <Loader2 size={12} className="animate-spin" />{label || '处理中'}
    </span>
  );
}

/* ───────────── 弹窗 ───────────── */
export function Modal({
  open, onClose, title, children, footer, wide,
}: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      style={{ background: 'rgba(3,5,8,0.78)', backdropFilter: 'blur(3px)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="hud-panel w-full animate-fade-up flex flex-col"
        style={{
          maxWidth: wide ? 880 : 560,
          maxHeight: '92vh',
          borderRadius: '8px 8px 0 0',
          background: 'linear-gradient(180deg,#0e141d 0%,#080b10 100%)',
        }}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
          <h3 className="fs-subheading" style={{ color: '#e8fff3' }}>{title}</h3>
          <button className="btn btn-ghost !p-1.5" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </div>
        <div className="p-4 overflow-y-auto flex-1 min-w-0">{children}</div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-3 border-t" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/* ───────────── 表单域 ───────────── */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <label className="field-label">{label}</label>
      {children}
      {hint && <div className="fs-tiny mt-1" style={{ color: '#4a5768' }}>{hint}</div>}
    </div>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`field ${props.className || ''}`} />;
}
export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`field ${props.className || ''}`} />;
}
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`field ${props.className || ''}`} />;
}

/* ───────────── 复制 ───────────── */
export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  return (
    <button
      className="btn btn-ghost !py-1 !px-2"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        setDone(true);
        timer.current = window.setTimeout(() => setDone(false), 1600);
      }}
    >
      {done ? <Check size={12} /> : <Copy size={12} />}
      <span className="fs-tiny">{label || (done ? '已复制' : '复制')}</span>
    </button>
  );
}

/* ───────────── 轻量 toast ───────────── */
type ToastKind = 'ok' | 'err' | 'info';
interface ToastItem { id: number; message: string; kind: ToastKind }
let pushToast: ((t: ToastItem) => void) | null = null;
let toastSeq = 0;

export function notify(message: string, kind: ToastKind = 'info') {
  toastSeq += 1;
  pushToast?.({ id: toastSeq, message, kind });
}

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    pushToast = (t) => {
      setItems((prev) => [...prev, t]);
      window.setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== t.id)), 4000);
    };
    return () => { pushToast = null; };
  }, []);
  return (
    <div className="fixed z-[60] flex flex-col gap-2" style={{ right: 'clamp(0.75rem,3vw,1.5rem)', bottom: 'clamp(0.75rem,3vw,1.5rem)', maxWidth: 'min(90vw, 360px)' }}>
      {items.map((t) => {
        const color = t.kind === 'ok' ? '#22e3a0' : t.kind === 'err' ? '#ff2d55' : '#ffb020';
        const Icon = t.kind === 'ok' ? CheckCircle2 : t.kind === 'err' ? AlertTriangle : Info;
        return (
          <div key={t.id} className="hud-panel animate-fade-up flex items-start gap-2 px-3 py-2.5" style={{ borderColor: `${color}55` }}>
            <Icon size={15} style={{ color, marginTop: 2, flexShrink: 0 }} />
            <span className="fs-small" style={{ color: '#e8fff3' }}>{t.message}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ───────────── 分页 ───────────── */
export function Pager({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (p: number) => void }) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-center gap-3 py-3">
      <button className="btn btn-ghost !py-1" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        <ChevronLeft size={13} />上一页
      </button>
      <span className="fs-tiny font-mono" style={{ color: '#7d9b8a' }}>{page} / {totalPages}</span>
      <button className="btn btn-ghost !py-1" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
        下一页<ChevronRight size={13} />
      </button>
    </div>
  );
}

/* ───────────── 时间格式 ───────────── */
export function fmtTime(value?: string): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function fmtRelative(value?: string): string {
  if (!value) return '—';
  const d = new Date(value).getTime();
  if (Number.isNaN(d)) return '—';
  const diff = Date.now() - d;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/* ───────────── 复核工作流专用组件 ───────────── */

import type { Tier, ReviewState, Origin } from '../lib/api';
import { STATE_META, TIER_META } from '../lib/review';

const TIER_COLOR: Record<Tier, { c: string; b: string; bg: string }> = {
  confirmed: { c: '#00ff88', b: 'rgba(0,255,136,0.45)', bg: 'rgba(0,255,136,0.1)' },
  suspect: { c: '#ffb000', b: 'rgba(255,176,0,0.42)', bg: 'rgba(255,176,0,0.1)' },
  noise: { c: '#ff2b3d', b: 'rgba(255,43,61,0.42)', bg: 'rgba(255,43,61,0.1)' },
};

export function TierBadge({ tier, score }: { tier?: Tier; score?: number }) {
  const t = tier || 'suspect';
  const m = TIER_COLOR[t];
  return (
    <span className="chip" style={{ color: m.c, background: m.bg, borderColor: m.b, fontWeight: 600 }}>
      {TIER_META[t].label}
      {typeof score === 'number' ? ` ${score}` : ''}
    </span>
  );
}

const STATE_COLOR: Record<ReviewState, string> = {
  new: '#7d9b8a',
  normalized: '#7d9b8a',
  awaiting_human: '#ffb000',
  auto_verified: '#38d9ff',
  confirmed: '#00ff88',
  rejected: '#ff2b3d',
  uncertain: '#ffb000',
  retest: '#38d9ff',
};

export function ReviewStateChip({ state }: { state: ReviewState }) {
  const meta = STATE_META[state] || STATE_META.new;
  const color = STATE_COLOR[state] || '#7d9b8a';
  return (
    <span className="chip" style={{ color, borderColor: `${color}66` }} title={meta.desc}>
      <span style={{ width: 5, height: 5, background: color, display: 'inline-block' }} />
      {meta.label}
    </span>
  );
}

const ORIGIN_LABEL: Record<Origin, string> = { scanner: '扫描器', agent: 'Agent', manual: '人工' };

export function OriginChip({ origin, agent }: { origin?: Origin; agent?: string }) {
  const o = origin || 'scanner';
  const color = o === 'agent' ? '#38d9ff' : o === 'manual' ? '#00ff88' : '#7d9b8a';
  return (
    <span className="chip" style={{ color, borderColor: `${color}55` }}>
      {ORIGIN_LABEL[o]}{agent ? `:${agent}` : ''}
    </span>
  );
}

/** 置信度条：数字 + 分档刻度 */
export function ConfidenceMeter({ score, tier }: { score?: number; tier?: Tier }) {
  const v = Math.max(0, Math.min(100, score ?? 0));
  const t = tier || (v >= 75 ? 'confirmed' : v >= 45 ? 'suspect' : 'noise');
  const color = TIER_COLOR[t].c;
  return (
    <div className="flex items-center gap-2 min-w-0" style={{ minWidth: 118 }}>
      <div className="flex-1 relative" style={{ height: 6, background: 'rgba(0,255,136,0.08)', border: '1px solid rgba(0,255,136,0.14)' }}>
        <div style={{ width: `${v}%`, height: '100%', background: color, boxShadow: `0 0 10px ${color}88`, transition: 'width .4s' }} />
        <span style={{ position: 'absolute', left: '45%', top: 0, bottom: 0, width: 1, background: 'rgba(255,176,0,0.5)' }} />
        <span style={{ position: 'absolute', left: '75%', top: 0, bottom: 0, width: 1, background: 'rgba(0,255,136,0.6)' }} />
      </div>
      <span className="fs-tiny font-mono" style={{ color, width: 26, textAlign: 'right' }}>{v}</span>
    </div>
  );
}

/** 命令面板/终端风格代码行 */
export function TerminalBlock({ title, content, maxHeight = 240 }: { title?: string; content?: string; maxHeight?: number }) {
  if (!content) return null;
  return (
    <div className="min-w-0">
      {title && <div className="cmd-label mb-1.5">{title}</div>}
      <div className="terminal" style={{ maxHeight }}>{content}</div>
    </div>
  );
}

/** 一行 key/value，作战台台账风 */
export function Kv({ k, v, mono = true }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2 min-w-0 py-1" style={{ borderBottom: '1px dashed rgba(0,255,136,0.1)' }}>
      <span className="fs-tiny shrink-0" style={{ color: '#4e6b5c', letterSpacing: '0.08em', minWidth: 76 }}>{k}</span>
      <span className={`fs-small min-w-0 flex-1 ${mono ? 'font-mono' : ''}`} style={{ color: '#b8d6c4', overflowWrap: 'anywhere' }}>{v}</span>
    </div>
  );
}
