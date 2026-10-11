import { useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft, MonitorPlay, Radio, Terminal } from 'lucide-react';
import { navigate } from '../lib/router';
import { useAuth } from '../lib/auth';

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  group: string;
  run: () => void;
}

export function CommandPalette({
  open, onClose, nav, crt, onToggleCrt,
}: {
  open: boolean;
  onClose: () => void;
  nav: Array<{ path: string; label: string; code: string }>;
  crt: boolean;
  onToggleCrt: () => void;
}) {
  const { logout } = useAuth();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands: PaletteCommand[] = useMemo(() => [
    ...nav.map((n) => ({
      id: `goto:${n.path}`,
      label: `cd ${n.code}`,
      hint: n.label,
      group: '导航',
      run: () => navigate(n.path),
    })),
    { id: 'crt', label: crt ? 'crt off' : 'crt on', hint: '切换 CRT 扫描线 / 噪点', group: '环境', run: onToggleCrt },
    { id: 'logout', label: 'disconnect', hint: '断开当前会话', group: '会话', run: logout },
  ], [nav, crt, onToggleCrt, logout]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => `${c.label} ${c.hint || ''} ${c.group}`.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      const t = window.setTimeout(() => inputRef.current?.focus(), 30);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [open]);

  useEffect(() => { setCursor(0); }, [query]);

  if (!open) return null;

  const fire = (cmd?: PaletteCommand) => {
    if (!cmd) return;
    onClose();
    window.setTimeout(() => cmd.run(), 10);
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-start justify-center"
      style={{ background: 'rgba(1,3,2,0.72)', paddingTop: 'clamp(3rem, 12vh, 8rem)', paddingInline: 'clamp(0.75rem,4vw,2rem)' }}
      onClick={onClose}
    >
      <div className="cmd-panel w-full" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2" style={{ padding: '0.7rem 0.85rem', borderBottom: '1px solid rgba(0,255,136,0.16)' }}>
          <Terminal size={14} style={{ color: '#00ff88' }} />
          <span className="fs-small" style={{ color: '#00ff88' }}>$</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, filtered.length - 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
              if (e.key === 'Enter') { e.preventDefault(); fire(filtered[cursor]); }
              if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            }}
            placeholder="敲命令… 例如 triage / agent / fp / crt off"
            className="flex-1 min-w-0 bg-transparent outline-none fs-small"
            style={{ color: '#e8fff3', border: 'none' }}
          />
        </div>
        <div className="overflow-y-auto" style={{ maxHeight: 'min(52vh, 420px)' }}>
          {filtered.length === 0 && (
            <div className="fs-small" style={{ padding: '1rem 0.85rem', color: '#4e6b5c' }}>
              command not found: {query}
            </div>
          )}
          {filtered.map((c, i) => (
            <button
              key={c.id}
              onMouseEnter={() => setCursor(i)}
              onClick={() => fire(c)}
              className={`w-full flex items-center gap-3 text-left ${i === cursor ? 'cmd-item-active' : ''}`}
              style={{ padding: '0.55rem 0.85rem', color: i === cursor ? '#e8fff3' : '#7d9b8a' }}
            >
              <span className="fs-small font-mono" style={{ color: i === cursor ? '#00ff88' : '#4e6b5c', minWidth: 104 }}>{c.label}</span>
              <span className="fs-tiny flex-1 min-w-0 truncate" style={{ color: '#7d9b8a' }}>{c.hint}</span>
              <span className="fs-tiny" style={{ color: '#3f5c4a' }}>{c.group}</span>
              {i === cursor && <CornerDownLeft size={12} style={{ color: '#00ff88' }} />}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 fs-tiny" style={{ padding: '0.45rem 0.85rem', borderTop: '1px solid rgba(0,255,136,0.12)', color: '#3f5c4a' }}>
          <span className="flex items-center gap-1"><Radio size={10} />↑↓ 选择</span>
          <span className="flex items-center gap-1"><CornerDownLeft size={10} />Enter 执行</span>
          <span className="flex items-center gap-1"><MonitorPlay size={10} />Esc 关闭</span>
          <span className="ml-auto">{filtered.length} 条</span>
        </div>
      </div>
    </div>
  );
}
