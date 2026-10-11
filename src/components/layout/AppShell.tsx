import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  LayoutDashboard, Crosshair, ScanLine, Server, ShieldAlert, FlaskConical, Cpu, FileText,
  LogOut, Menu, X, Wifi, WifiOff, Radar, GitBranch, Fingerprint, Plug, Terminal, Search,
  MonitorPlay, Activity, Ruler, Bot,
} from 'lucide-react';
import { allRecords, type Worker, type Finding, type ReviewItem } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { navigate, parseRoute } from '../../lib/router';
import { fmtRelative } from '../kit';
import { CommandPalette } from '../CommandPalette';

const NAV: Array<{ path: string; label: string; icon: typeof LayoutDashboard; code: string }> = [
  { path: '/dashboard', label: '作战概览', icon: LayoutDashboard, code: 'ops' },
  { path: '/targets', label: '授权目标', icon: Crosshair, code: 'scope' },
  { path: '/scans', label: '任务编排', icon: ScanLine, code: 'run' },
  { path: '/assets', label: '资产测绘', icon: Server, code: 'map' },
  { path: '/findings', label: '漏洞发现', icon: ShieldAlert, code: 'hit' },
  { path: '/review', label: '复核工作台', icon: GitBranch, code: 'triage' },
  { path: '/fingerprints', label: '误报指纹库', icon: Fingerprint, code: 'fp' },
  { path: '/pocs', label: 'POC 库', icon: FlaskConical, code: 'poc' },
  { path: '/workers', label: '执行器', icon: Cpu, code: 'node' },
  { path: '/agent', label: 'Agent 接入', icon: Plug, code: 'agent' },
  { path: '/rubrics', label: '判定准则', icon: Ruler, code: 'rubric' },
  { path: '/reports', label: '中文报告', icon: FileText, code: 'rpt' },
  { path: '/console', label: '对话式作战台', icon: Bot, code: 'chat' },
];

function useOpsFeed() {
  const [worker, setWorker] = useState<Worker | null>(null);
  const [feed, setFeed] = useState<ReviewItem[]>([]);
  const [awaiting, setAwaiting] = useState(0);
  const [hits, setHits] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [workers, queue, findings] = await Promise.all([
          allRecords<Worker>('workers', { sort: '-last_seen', perPage: 20 }, 20).catch(() => [] as Worker[]),
          allRecords<ReviewItem>('review_queue', { sort: '-created', perPage: 24 }, 24).catch(() => [] as ReviewItem[]),
          allRecords<Finding>('findings', { sort: '-created', perPage: 1 }, 1).catch(() => [] as Finding[]),
        ]);
        if (!alive) return;
        const online = workers.find((w) => w.status === 'online' || w.status === 'idle');
        setWorker(online || workers[0] || null);
        setFeed(queue);
        setAwaiting(queue.filter((q) => q.state === 'awaiting_human' || q.state === 'auto_verified' || q.state === 'new' || q.state === 'normalized').length);
        setHits(findings.length);
      } catch { /* 静默 */ }
    };
    void load();
    const t = window.setInterval(load, 30_000);
    return () => { alive = false; window.clearInterval(t); };
  }, []);

  return { worker, feed, awaiting, hits };
}

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const bj = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    time: `${pad(bj.getHours())}:${pad(bj.getMinutes())}:${pad(bj.getSeconds())}`,
    date: `${bj.getFullYear()}-${pad(bj.getMonth() + 1)}-${pad(bj.getDate())}`,
  };
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5" style={{ paddingInline: 'clamp(0.75rem,3vw,1rem)', paddingBlock: 'clamp(0.8rem,3vw,1rem)' }}>
      <div
        className="grid place-items-center shrink-0"
        style={{ width: 34, height: 34, borderRadius: 2, background: 'rgba(0,255,136,0.08)', border: '1px solid rgba(0,255,136,0.42)', color: '#00ff88', boxShadow: '0 0 18px rgba(0,255,136,0.22)' }}
      >
        <Radar size={19} />
      </div>
      <div className="min-w-0">
        <div className="font-title leading-none" style={{ color: '#e8fff3', fontSize: '1.06rem', letterSpacing: '0.06em' }}>
          <span className="glow-text">RECON</span>
          <span style={{ color: '#ff2b3d' }}>_</span>
          <span style={{ color: '#b8d6c4' }}>LAB</span>
        </div>
        <div className="fs-tiny" style={{ color: '#4e6b5c', letterSpacing: '0.14em', textTransform: 'uppercase' }}>authorized pentest ops</div>
      </div>
    </div>
  );
}

function NavList({ active, onPick, awaiting }: { active: string; onPick: () => void; awaiting: number }) {
  return (
    <nav className="flex flex-col gap-0.5" style={{ paddingInline: '0.5rem', marginTop: '0.25rem' }}>
      {NAV.map((item) => {
        const Icon = item.icon;
        const isActive = active === item.path;
        return (
          <button
            key={item.path}
            onClick={() => { navigate(item.path); onPick(); }}
            className="flex items-center gap-2.5 text-left transition-colors"
            style={{
              padding: '0.5rem 0.6rem',
              background: isActive ? 'rgba(0,255,136,0.09)' : 'transparent',
              borderLeft: `2px solid ${isActive ? '#00ff88' : 'transparent'}`,
              color: isActive ? '#e8fff3' : '#7d9b8a',
              fontFamily: "'Share Tech Mono', ui-monospace, monospace",
              fontSize: 'var(--fs-small)',
              letterSpacing: '0.05em',
            }}
          >
            <Icon size={15} style={{ color: isActive ? '#00ff88' : '#4e6b5c', flexShrink: 0 }} />
            <span className="truncate flex-1">{item.label}</span>
            {item.path === '/review' && awaiting > 0 && (
              <span className="chip" style={{ color: '#ffb000', borderColor: 'rgba(255,176,0,0.4)', padding: '0 0.3rem' }}>{awaiting}</span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

function AlarmTicker({ feed, onOpenPalette }: { feed: ReviewItem[]; onOpenPalette: () => void }) {
  const line = useMemo(() => {
    const items = feed.slice(0, 12);
    if (!items.length) {
      return ['[idle] 复核队列为空 · 未捕获待处理信号 · 等待执行器上报', '[sys] 所有通道静默 · 无越权行为 · 链路正常'];
    }
    return items.map((it) => {
      const tag = it.state === 'rejected' ? 'FALSE-POS' : it.state === 'confirmed' ? 'CONFIRMED' : 'PENDING';
      return `[${tag}] ${it.rule_id || it.title} · ${it.url || 'n/a'} · conf=${it.confidence ?? 0} · ${fmtRelative(it.created)}`;
    });
  }, [feed]);

  const text = line.join('   ///   ');

  return (
    <div className="ticker-wrap flex items-center" style={{ height: 26 }}>
      <button
        onClick={onOpenPalette}
        className="fs-tiny shrink-0 h-full flex items-center gap-1"
        style={{ paddingInline: '0.6rem', background: 'rgba(255,43,61,0.18)', color: '#ff8a94', letterSpacing: '0.1em', borderRight: '1px solid rgba(255,43,61,0.3)' }}
      >
        <Activity size={11} className="animate-blink" />SIG
      </button>
      <div className="flex-1 overflow-hidden">
        <div className="ticker-track fs-tiny" style={{ color: '#ff8a94', letterSpacing: '0.04em' }}>
          <span style={{ paddingInline: '1.5rem' }}>{text}</span>
          <span style={{ paddingInline: '1.5rem' }}>{text}</span>
        </div>
      </div>
    </div>
  );
}

function StatusRail({ online, worker, clock, crt, onToggleCrt, hits, awaiting }: {
  online: boolean; worker: Worker | null; clock: { time: string; date: string };
  crt: boolean; onToggleCrt: () => void; hits: number; awaiting: number;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap fs-tiny font-mono" style={{ color: '#4e6b5c' }}>
      <span className="chip" style={{ color: '#00ff88', borderColor: 'rgba(0,255,136,0.3)' }}>
        {clock.date} <span style={{ color: '#e8fff3' }}>{clock.time}</span> CST
      </span>
      <span className="chip" style={{ color: online ? '#00ff88' : '#ff2b3d', borderColor: online ? 'rgba(0,255,136,0.3)' : 'rgba(255,43,61,0.35)' }}>
        node:{online ? 'up' : 'down'}
      </span>
      <span className="chip hidden md:inline-flex" style={{ color: '#7d9b8a' }}>sess:{worker?.hostname ? worker.hostname.slice(0, 10) : 'local'}</span>
      <span className="chip hidden sm:inline-flex" style={{ color: awaiting > 0 ? '#ffb000' : '#4e6b5c', borderColor: awaiting > 0 ? 'rgba(255,176,0,0.35)' : undefined }}>
        待复核 {awaiting}
      </span>
      <span className="chip hidden lg:inline-flex" style={{ color: '#7d9b8a' }}>命中 {hits}</span>
      <button
        onClick={onToggleCrt}
        className="chip"
        style={{ color: crt ? '#00ff88' : '#4e6b5c', borderColor: crt ? 'rgba(0,255,136,0.3)' : undefined }}
        title="切换 CRT 扫描线"
      >
        <MonitorPlay size={11} />CRT
      </button>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const route = parseRoute(window.location.hash.replace(/^#/, '') || '/dashboard');
  const { worker, feed, awaiting, hits } = useOpsFeed();
  const clock = useClock();
  const [drawer, setDrawer] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [crt, setCrt] = useState(() => {
    try { return localStorage.getItem('reconlab_crt') !== 'off'; } catch { return true; }
  });

  useEffect(() => {
    document.documentElement.classList.toggle('crt-off', !crt);
    try { localStorage.setItem('reconlab_crt', crt ? 'on' : 'off'); } catch { /* ignore */ }
  }, [crt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      if (e.key === 'Escape') setPaletteOpen(false);
      if (e.key === '/') {
        const target = e.target as HTMLElement;
        if (target && /input|textarea|select/i.test(target.tagName)) return;
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const online = worker?.status === 'online' || worker?.status === 'idle';
  const title = NAV.find((n) => n.path === route.base)?.label || '作战台';

  return (
    <div className="min-h-screen">
      <aside
        className="hidden lg:flex flex-col fixed top-0 bottom-0 left-0 z-30"
        style={{
          width: 'var(--sidebar-w)',
          background: 'linear-gradient(180deg, rgba(6,12,8,0.99) 0%, rgba(2,5,3,0.99) 100%)',
          borderRight: '1px solid rgba(0,255,136,0.14)',
        }}
      >
        <Brand />
        <div className="divider-dashed mx-3" />
        <div className="flex-1 overflow-y-auto pb-4 no-scrollbar"><NavList active={route.base} onPick={() => setDrawer(false)} awaiting={awaiting} /></div>
        <div className="px-3 pb-3 pt-2" style={{ borderTop: '1px solid rgba(0,255,136,0.12)' }}>
          <div className="fs-tiny truncate px-1 mb-2" style={{ color: '#4e6b5c' }}>
            <Terminal size={10} className="inline mr-1" />{user?.email || '未登录'}
          </div>
          <button className="btn btn-ghost w-full !justify-start" onClick={logout}>
            <LogOut size={14} />断开连接
          </button>
        </div>
      </aside>

      {drawer && (
        <div className="lg:hidden fixed inset-0 z-50" style={{ background: 'rgba(1,3,2,0.86)' }} onClick={() => setDrawer(false)}>
          <div
            className="h-full flex flex-col"
            style={{ width: 'min(86vw, 290px)', background: '#050b08', borderRight: '1px solid rgba(0,255,136,0.18)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <Brand />
              <button className="btn btn-ghost !p-1.5 mr-3" onClick={() => setDrawer(false)} aria-label="收起"><X size={16} /></button>
            </div>
            <div className="flex-1 overflow-y-auto"><NavList active={route.base} onPick={() => setDrawer(false)} awaiting={awaiting} /></div>
            <div className="px-3 py-3" style={{ borderTop: '1px solid rgba(0,255,136,0.12)' }}>
              <button className="btn btn-ghost w-full !justify-start" onClick={logout}><LogOut size={14} />断开连接</button>
            </div>
          </div>
        </div>
      )}

      <div className="lg:ml-[244px] min-w-0 flex flex-col min-h-screen">
        <header
          className="sticky top-0 z-20"
          style={{
            background: 'rgba(3,6,5,0.92)',
            backdropFilter: 'blur(10px)',
            borderBottom: '1px solid rgba(0,255,136,0.16)',
          }}
        >
          <div className="flex items-center gap-3" style={{ paddingInline: 'var(--section-px)', paddingBlock: '0.6rem' }}>
            <button className="lg:hidden btn btn-ghost !p-1.5" onClick={() => setDrawer(true)} aria-label="菜单"><Menu size={17} /></button>
            <h1 className="fs-subheading truncate min-w-0" style={{ color: '#e8fff3', letterSpacing: '0.04em' }}>
              <span style={{ color: '#00ff88', opacity: 0.7 }}>/</span>{title}
            </h1>
            <button
              onClick={() => setPaletteOpen(true)}
              className="hidden md:flex items-center gap-2 flex-1 min-w-0 max-w-[340px]"
              style={{ padding: '0.4rem 0.6rem', border: '1px solid rgba(0,255,136,0.16)', background: 'rgba(0,255,136,0.03)', color: '#4e6b5c', fontFamily: "'IBM Plex Mono',monospace", fontSize: 'var(--fs-tiny)' }}
            >
              <Search size={12} />
              <span className="flex-1 text-left">敲命令或搜目标…</span>
              <span className="chip" style={{ padding: '0 0.28rem' }}>Ctrl K</span>
            </button>
            <div className="flex-1 hidden md:block" />
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => navigate('/workers')}
                className="chip"
                style={{ color: online ? '#00ff88' : '#ff2b3d', borderColor: online ? 'rgba(0,255,136,0.35)' : 'rgba(255,43,61,0.4)' }}
              >
                {online ? <Wifi size={11} /> : <WifiOff size={11} />}
                <span className="hidden sm:inline">{online ? '执行器在线' : '执行器离线'}</span>
                <span className="sm:hidden">{online ? '在线' : '离线'}</span>
              </button>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 flex-wrap" style={{ paddingInline: 'var(--section-px)', paddingBottom: '0.5rem' }}>
            <StatusRail
              online={!!online}
              worker={worker}
              clock={clock}
              crt={crt}
              onToggleCrt={() => setCrt((v) => !v)}
              hits={hits}
              awaiting={awaiting}
            />
          </div>
          <AlarmTicker feed={feed} onOpenPalette={() => setPaletteOpen(true)} />
        </header>

        <main className="flex-1 min-w-0 pb-10">{children}</main>

        <footer
          className="fs-tiny text-center"
          style={{ color: '#3a5545', paddingInline: 'var(--section-px)', paddingBlock: '1rem', borderTop: '1px solid rgba(0,255,136,0.08)' }}
        >
          <span style={{ color: '#00ff88', opacity: 0.6 }}>RECONLAB v2</span> · 仅限对已获书面授权的目标使用 · 所有操作留痕可审计 · <span className="cursor-blink" />
        </footer>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} nav={NAV} crt={crt} onToggleCrt={() => setCrt((v) => !v)} />
    </div>
  );
}
