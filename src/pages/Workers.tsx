import { useEffect, useMemo, useState } from 'react';
import { Cpu, Download, Terminal, Wifi, WifiOff, Trash2, RefreshCw, CheckCircle2, Circle } from 'lucide-react';
import { allRecords, deleteRecord, type Scan, type Worker } from '../lib/api';
import { useAuth } from '../lib/auth';
import { CopyButton, EmptyState, Spinner, fmtRelative, notify } from '../components/kit';

const CAP_LABEL: Record<string, string> = {
  nmap: 'nmap', subfinder: 'subfinder', httpx: 'httpx', nuclei: 'nuclei',
  sqlmap: 'sqlmap', whatweb: 'whatweb', builtin: '内置引擎',
};

export function WorkersPage() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [scans, setScans] = useState<Scan[]>([]);

  const load = async () => {
    try {
      const [wList, sList] = await Promise.all([
        allRecords<Worker>('workers', { sort: '-last_seen', perPage: 50 }, 100),
        allRecords<Scan>('scans', { perPage: 100, sort: '-created', fields: 'id,name,status,worker,progress' }, 100),
      ]);
      setWorkers(wList);
      setScans(sList);
    } catch (e) {
      notify(e instanceof Error ? e.message : '加载失败', 'err');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const t = window.setInterval(() => { void load(); }, 15_000);
    return () => window.clearInterval(t);
  }, []);

  const origin = useMemo(() => window.location.origin, []);
  const cmd = `python3 reconlab-worker.py --server ${origin} --email ${user?.email || '你的邮箱'} --password 你的密码 --name 我的电脑`;

  if (loading) return <Spinner label="正在查询执行器…" />;

  const activeWorker = workers.find((w) => w.status === 'online' || w.status === 'idle');

  return (
    <div className="section-wrap">
      <div className="container-fluid flex flex-col" style={{ gap: 'var(--gap-fluid)' }}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="fs-small flex-1" style={{ color: '#8896a8' }}>共 {workers.length} 台执行器</span>
          <button className="btn btn-ghost" onClick={() => void load()}><RefreshCw size={14} />刷新</button>
        </div>

        {workers.length === 0 ? (
          <div className="hud-panel">
            <EmptyState
              icon={<Cpu size={30} />}
              title="还没有执行器接入"
              desc="控制台负责编排与留痕,真正的扫描在你自己的机器上跑。按下面的步骤接一台进来,任务就会自动开工。"
            />
          </div>
        ) : (
          <div className="grid-auto">
            {workers.map((w) => {
              const online = w.status === 'online' || w.status === 'idle';
              const running = scans.find((s) => s.worker === w.id && s.status === 'running');
              return (
                <div key={w.id} className="hud-panel p-3.5 flex flex-col gap-2.5 min-w-0">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="grid place-items-center shrink-0" style={{ width: 32, height: 32, borderRadius: 5, background: online ? 'rgba(34,227,160,0.09)' : 'rgba(255,138,61,0.09)', border: `1px solid ${online ? 'rgba(34,227,160,0.28)' : 'rgba(255,138,61,0.28)'}`, color: online ? '#22e3a0' : '#ff8a3d' }}>
                      {online ? <Wifi size={16} /> : <WifiOff size={16} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="fs-small font-medium truncate" style={{ color: '#eaf1f8' }}>{w.name || '未命名执行器'}</div>
                      <div className="fs-tiny font-mono truncate" style={{ color: '#8896a8' }}>{w.hostname || '—'} · {w.os || '—'}</div>
                    </div>
                    <span className="chip shrink-0" style={{ color: online ? '#22e3a0' : '#5d6b7d' }}>{online ? '在线' : '离线'}</span>
                  </div>

                  <div className="fs-tiny" style={{ color: '#5d6b7d' }}>
                    心跳 {fmtRelative(w.last_seen)}{w.version ? ` · v${w.version}` : ''}
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {(w.caps || 'builtin').split(',').filter(Boolean).map((c) => (
                      <span key={c} className="chip" style={{ color: '#4cc9f0', borderColor: 'rgba(76,201,240,0.28)' }}>{CAP_LABEL[c.trim()] || c.trim()}</span>
                    ))}
                  </div>

                  {running && (
                    <div className="fs-tiny" style={{ color: '#ffb020' }}>正在执行:{running.name}</div>
                  )}

                  <div className="flex items-center gap-2 mt-auto pt-1">
                    <button
                      className="btn btn-danger !py-1 !px-2 ml-auto"
                      onClick={async () => {
                        try {
                          await deleteRecord('workers', w.id);
                          setWorkers((prev) => prev.filter((x) => x.id !== w.id));
                          notify('已移除该执行器记录', 'ok');
                        } catch (e) { notify(e instanceof Error ? e.message : '操作失败', 'err'); }
                      }}
                    >
                      <Trash2 size={12} /><span className="fs-tiny">移除</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 接入指引 */}
        <div className="hud-panel min-w-0">
          <div className="panel-head"><Terminal size={13} style={{ color: '#22e3a0' }} /><span>接入执行器(三步)</span></div>
          <div className="p-4 flex flex-col gap-4">
            <div className="flex gap-3">
              <div className="shrink-0 grid place-items-center" style={{ width: 24, height: 24, borderRadius: 4, background: 'rgba(34,227,160,0.1)', border: '1px solid rgba(34,227,160,0.3)', color: '#22e3a0', fontFamily: "'JetBrains Mono',monospace", fontSize: 12 }}>1</div>
              <div className="min-w-0 flex-1">
                <div className="fs-small mb-1.5" style={{ color: '#eaf1f8' }}>下载执行器脚本(单文件,零依赖)</div>
                <a className="btn btn-ghost" href="/worker/reconlab-worker.py" download>
                  <Download size={14} />reconlab-worker.py
                </a>
                <div className="fs-tiny mt-1.5" style={{ color: '#5d6b7d' }}>需要本机有 Python 3.9 或更高版本。想让它更强,顺手装 nmap / nuclei / subfinder / httpx,脚本会自动调用。</div>
              </div>
            </div>

            <div className="flex gap-3">
              <div className="shrink-0 grid place-items-center" style={{ width: 24, height: 24, borderRadius: 4, background: 'rgba(34,227,160,0.1)', border: '1px solid rgba(34,227,160,0.3)', color: '#22e3a0', fontFamily: "'JetBrains Mono',monospace", fontSize: 12 }}>2</div>
              <div className="min-w-0 flex-1">
                <div className="fs-small mb-1.5" style={{ color: '#eaf1f8' }}>在你自己机器上跑起来</div>
                <div className="terminal" style={{ maxHeight: 140 }}>{cmd}</div>
                <div className="mt-2"><CopyButton text={cmd} label="复制命令" /></div>
                <div className="fs-tiny mt-1.5" style={{ color: '#5d6b7d' }}>
                  用你在这个控制台注册的邮箱密码登录。加 <span className="font-mono">--once</span> 只领一个任务就跑完退出,适合临时验证。
                </div>
              </div>
            </div>

            <div className="flex gap-3">
              <div className="shrink-0 grid place-items-center" style={{ width: 24, height: 24, borderRadius: 4, background: 'rgba(34,227,160,0.1)', border: '1px solid rgba(34,227,160,0.3)', color: '#22e3a0', fontFamily: "'JetBrains Mono',monospace", fontSize: 12 }}>3</div>
              <div className="min-w-0 flex-1">
                <div className="fs-small mb-1.5" style={{ color: '#eaf1f8' }}>回到任务编排下发任务</div>
                <div className="fs-tiny" style={{ color: '#5d6b7d' }}>
                  执行器在线后会自动领取排队中的任务,日志实时回传到这里。执行器离线时任务只是排队,不会丢。
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-1.5 pt-2" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
              <div className="fs-tiny uppercase tracking-widest" style={{ color: '#5d6b7d', fontFamily: "'Chakra Petch',sans-serif" }}>当前状态</div>
              {activeWorker ? (
                <div className="flex items-center gap-2 fs-small" style={{ color: '#22e3a0' }}>
                  <CheckCircle2 size={14} />已有执行器在线,可以直接下发任务
                </div>
              ) : (
                <div className="flex items-center gap-2 fs-small" style={{ color: '#ff8a3d' }}>
                  <Circle size={14} />暂无在线执行器,任务会排队等待
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
