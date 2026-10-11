import { useEffect, useState, type FormEvent } from 'react';
import { Radar, Terminal, Loader2, Crosshair, ShieldCheck, FileText, Fingerprint } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { TextInput, Field } from '../components/kit';

const BOOT_LOG: Array<[string, string, 'ok' | 'dim' | 'warn']> = [
  ['0.001', 'reconlab bootloader v2.0 · chain-of-custody enabled', 'dim'],
  ['0.014', 'mount /dev/scope-guard ......................... OK', 'ok'],
  ['0.031', 'load fingerprint-normalizer ..................... OK', 'ok'],
  ['0.048', 'load false-positive-shield ...................... OK', 'ok'],
  ['0.059', 'load evidence-vault (write-once) ................ OK', 'ok'],
  ['0.072', 'link worker-bridge ..................... standby', 'warn'],
  ['0.088', 'agent-api ................................ listening', 'ok'],
  ['0.091', 'auth gate ................................... locked', 'dim'],
];

const ASCII = String.raw`
   ██████╗ ███████╗ ██████╗ ██████╗ ███╗   ██╗
   ██╔══██╗██╔════╝██╔════╝██╔═══██╗████╗  ██║
   ██████╔╝█████╗  ██║     ██║   ██║██╔██╗ ██║
   ██╔══██╗██╔══╝  ██║     ██║   ██║██║╚██╗██║
   ██║  ██║███████╗╚██████╗╚██████╔╝██║ ╚████║
   ╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝  /LAB`;

function friendlyError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes('failed to authenticate') || m.includes('invalid')) return '邮箱或密码不对';
  if (m.includes('already exist')) return '这个邮箱已经注册过了';
  if (m.includes('at least 8')) return '密码至少 8 位';
  if (m.includes('valid email')) return '邮箱格式不对';
  return msg;
}

export function LoginPage() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [booted, setBooted] = useState(0);

  useEffect(() => {
    if (booted >= BOOT_LOG.length) return undefined;
    const t = window.setTimeout(() => setBooted((n) => n + 1), booted === 0 ? 120 : 130);
    return () => window.clearTimeout(t);
  }, [booted]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      if (mode === 'login') await login(email.trim(), password);
      else await register(email.trim(), password);
    } catch (err) {
      setError(friendlyError(err instanceof Error ? err.message : '操作失败'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen grid lg:grid-cols-[1.1fr_1fr]">
      <div className="hidden lg:flex flex-col justify-center gap-5 relative overflow-hidden" style={{ borderRight: '1px solid rgba(0,255,136,0.14)', paddingInline: 'clamp(1.5rem,5vw,3.5rem)', paddingBlock: 'clamp(1.5rem,4vw,2.5rem)' }}>
        <div className="ascii-banner">{ASCII}</div>
        <div className="hud-panel boot-shell" style={{ padding: '0.9rem 1rem' }}>
          <div className="cmd-label mb-2">system self-test</div>
          <div className="fs-tiny font-mono" style={{ lineHeight: 1.9 }}>
            {BOOT_LOG.slice(0, booted).map(([t, line, kind]) => (
              <div key={t} style={{ color: kind === 'ok' ? '#00ff88' : kind === 'warn' ? '#ffb000' : '#4e6b5c' }}>
                <span style={{ color: '#2c4739' }}>[{t}]</span> {line}
              </div>
            ))}
            {booted >= BOOT_LOG.length && (
              <div className="cursor-blink" style={{ color: '#e8fff3' }}>&gt; waiting for operator credentials</div>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-2.5">
          {[
            { icon: Crosshair, text: '子域 / 端口 / 指纹 / 目录，四路侦查一次下发' },
            { icon: Fingerprint, text: '复核状态机 + 误报指纹库，命中不再等于漏洞' },
            { icon: ShieldCheck, text: 'Agent 直连复核队列，机器跑完人工签字才算数' },
            { icon: FileText, text: '主文只出已确认，疑似进附录，每条带可复现命令' },
          ].map(({ icon: Icon, text }) => (
            <div key={text} className="flex items-center gap-2.5">
              <Icon size={15} style={{ color: '#00ff88', flexShrink: 0 }} />
              <span className="fs-small" style={{ color: '#b8d6c4' }}>{text}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-center" style={{ paddingInline: 'var(--section-px)', paddingBlock: 'clamp(2rem,8vw,4rem)' }}>
        <div className="w-full" style={{ maxWidth: 420 }}>
          <div className="flex items-center gap-2.5 mb-7 lg:hidden">
            <div className="grid place-items-center" style={{ width: 34, height: 34, borderRadius: 2, background: 'rgba(0,255,136,0.1)', border: '1px solid rgba(0,255,136,0.4)', color: '#00ff88' }}>
              <Radar size={19} />
            </div>
            <div className="font-title" style={{ color: '#e8fff3', fontSize: '1.14rem', letterSpacing: '0.06em' }}>
              <span className="glow-text">RECON</span><span style={{ color: '#ff2b3d' }}>_</span>LAB
            </div>
          </div>

          <div className="hud-panel scanline" style={{ padding: 'clamp(1rem,4vw,1.5rem)' }}>
            <div className="flex items-center gap-2 mb-1">
              <Terminal size={15} style={{ color: '#00ff88' }} />
              <span className="fs-tiny uppercase" style={{ color: '#4e6b5c', letterSpacing: '0.16em' }}>
                {mode === 'login' ? 'operator sign-in' : 'new operator'}
              </span>
            </div>
            <h2 className="fs-heading mb-1" style={{ color: '#e8fff3' }}>
              {mode === 'login' ? '登入作战台' : '注册操作员'}
            </h2>
            <p className="fs-tiny mb-5" style={{ color: '#4e6b5c' }}>
              当前节点 已授权范围 · 所有操作写入证据链日志
            </p>

            <form onSubmit={submit} className="flex flex-col gap-4">
              <Field label="operator id / 邮箱">
                <TextInput
                  type="email"
                  required
                  autoComplete="username"
                  placeholder="operator@reconlab.local"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
              <Field label="passphrase" hint={mode === 'register' ? '至少 8 位' : undefined}>
                <TextInput
                  type="password"
                  required
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>

              {error && (
                <div className="fs-small" style={{ padding: '0.5rem 0.7rem', background: 'rgba(255,43,61,0.1)', border: '1px solid rgba(255,43,61,0.36)', color: '#ff8a94' }}>
                  ! {error}
                </div>
              )}

              <button type="submit" className="btn btn-primary w-full !py-2.5" disabled={busy}>
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Terminal size={15} />}
                {busy ? '握手校验中…' : mode === 'login' ? '建立会话' : '注册并建立会话'}
              </button>
            </form>

            <div className="fs-small mt-4 text-center" style={{ color: '#4e6b5c' }}>
              {mode === 'login' ? '还没有账号?' : '已经有账号了?'}{' '}
              <button
                style={{ color: '#00ff88' }}
                onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}
              >
                {mode === 'login' ? '注册一个' : '去登录'}
              </button>
            </div>
          </div>

          <p className="fs-tiny mt-4 text-center" style={{ color: '#3a5545' }}>
            仅限对已获书面授权的目标开展安全测试 · 越界目标会被范围守卫拦截
          </p>
        </div>
      </div>
    </div>
  );
}
