import { useEffect, useMemo, useState } from 'react';
import { Server, Search, Download, Trash2, Filter } from 'lucide-react';
import { allRecords, deleteRecord, type Asset, type Target } from '../lib/api';
import { EmptyState, Select, Spinner, TextInput, fmtTime, notify } from '../components/kit';

function toCsv(rows: Record<string, unknown>[], headers: { key: string; label: string }[]): string {
  const escape = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = headers.map((h) => escape(h.label)).join(',');
  const body = rows.map((r) => headers.map((h) => escape(r[h.key])).join(',')).join('\n');
  return `\uFEFF${head}\n${body}`;
}

function download(name: string, content: string, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function AssetsPage() {
  const [loading, setLoading] = useState(true);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [q, setQ] = useState('');
  const [svcFilter, setSvcFilter] = useState('');
  const [srcFilter, setSrcFilter] = useState('');
  const [confirmDel, setConfirmDel] = useState<Asset | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [aList, tList] = await Promise.all([
          allRecords<Asset>('assets', { sort: '-created', perPage: 100, fields: 'id,scan,target,host,port,service,title,tech,status_code,url,tls,created' }, 600),
          allRecords<Target>('targets', { perPage: 100, fields: 'id,name,value' }, 300),
        ]);
        if (!alive) return;
        setAssets(aList);
        setTargets(tList);
      } catch (e) {
        notify(e instanceof Error ? e.message : '加载失败', 'err');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const services = useMemo(() => Array.from(new Set(assets.map((a) => a.service).filter(Boolean) as string[])).slice(0, 30), [assets]);
  const targetMap = useMemo(() => new Map(targets.map((t) => [t.id, t])), [targets]);

  const filtered = useMemo(() => {
    const key = q.trim().toLowerCase();
    return assets.filter((a) => {
      if (svcFilter && a.service !== svcFilter) return false;
      if (srcFilter && a.target !== srcFilter) return false;
      if (!key) return true;
      return [a.host, a.url, a.title, a.tech, a.banner].filter(Boolean).some((v) => String(v).toLowerCase().includes(key));
    });
  }, [assets, q, svcFilter, srcFilter]);

  const exportCsv = () => {
    const csv = toCsv(
      filtered.map((a) => ({
        host: a.host, port: a.port, service: a.service, url: a.url,
        status: a.status_code, title: a.title, tech: a.tech, tls: a.tls,
        target: a.target ? (targetMap.get(a.target)?.value || '') : '',
        created: a.created,
      })),
      [
        { key: 'host', label: '主机' }, { key: 'port', label: '端口' }, { key: 'service', label: '服务' },
        { key: 'url', label: 'URL' }, { key: 'status', label: '状态码' }, { key: 'title', label: '标题' },
        { key: 'tech', label: '技术栈' }, { key: 'tls', label: 'TLS' }, { key: 'target', label: '所属目标' }, { key: 'created', label: '发现时间' },
      ],
    );
    download(`reconlab-assets-${Date.now()}.csv`, csv);
    notify(`已导出 ${filtered.length} 条资产`, 'ok');
  };

  if (loading) return <Spinner label="正在拉取资产…" />;

  return (
    <div className="section-wrap">
      <div className="container-fluid flex flex-col" style={{ gap: 'var(--gap-fluid)' }}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[160px]">
            <Search size={14} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: '#4a5768' }} />
            <TextInput placeholder="搜索主机 / 标题 / 技术栈…" value={q} onChange={(e) => setQ(e.target.value)} style={{ paddingLeft: 28 }} />
          </div>
          <div style={{ minWidth: 150 }}>
            <Select value={svcFilter} onChange={(e) => setSvcFilter(e.target.value)}>
              <option value="">全部服务</option>
              {services.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </div>
          <div style={{ minWidth: 160 }}>
            <Select value={srcFilter} onChange={(e) => setSrcFilter(e.target.value)}>
              <option value="">全部目标</option>
              {targets.map((t) => <option key={t.id} value={t.id}>{t.name || t.value}</option>)}
            </Select>
          </div>
          <button className="btn btn-ghost" onClick={exportCsv} disabled={filtered.length === 0}><Download size={14} />导出 CSV</button>
        </div>

        <div className="fs-tiny" style={{ color: '#5d6b7d' }}>
          <Filter size={11} style={{ display: 'inline', marginRight: 4 }} />
          共 {assets.length} 条资产,当前筛选出 {filtered.length} 条
        </div>

        {filtered.length === 0 ? (
          <div className="hud-panel">
            <EmptyState icon={<Server size={30} />} title="没有资产" desc="跑一轮子域枚举或端口扫描,结果会自动入库。" />
          </div>
        ) : (
          <div className="hud-panel overflow-hidden">
            <div className="overflow-x-auto">
              <table className="data-table" style={{ minWidth: 720 }}>
                <thead>
                  <tr>
                    <th>主机</th><th>端口</th><th>服务</th><th>状态</th>
                    <th>标题 / 技术栈</th><th className="hidden lg:table-cell">所属目标</th>
                    <th className="hidden md:table-cell">时间</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, 300).map((a) => (
                    <tr key={a.id}>
                      <td className="font-mono fs-tiny" style={{ color: '#22e3a0' }}>{a.host}</td>
                      <td className="font-mono fs-tiny">{a.port || '—'}</td>
                      <td className="fs-tiny">{a.service || '—'}</td>
                      <td className="font-mono fs-tiny" style={{ color: a.status_code && a.status_code < 400 ? '#22e3a0' : '#ff8a3d' }}>{a.status_code || '—'}</td>
                      <td className="fs-tiny truncate" style={{ maxWidth: 260, color: '#8896a8' }}>
                        {a.url ? <a href={a.url} target="_blank" rel="noreferrer" style={{ color: '#4cc9f0' }}>{a.title || a.url}</a> : (a.title || a.tech || a.banner || '—')}
                      </td>
                      <td className="hidden lg:table-cell fs-tiny truncate" style={{ color: '#5d6b7d', maxWidth: 160 }}>{a.target ? (targetMap.get(a.target)?.name || targetMap.get(a.target)?.value || '—') : '—'}</td>
                      <td className="hidden md:table-cell fs-tiny" style={{ color: '#5d6b7d', whiteSpace: 'nowrap' }}>{fmtTime(a.created)}</td>
                      <td>
                        <button className="btn btn-danger !py-1 !px-1.5" onClick={() => setConfirmDel(a)}><Trash2 size={11} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {filtered.length > 300 && (
              <div className="fs-tiny text-center py-2" style={{ color: '#5d6b7d' }}>只展示前 300 条,用搜索或筛选缩小范围(导出 CSV 会导全部 {filtered.length} 条)</div>
            )}
          </div>
        )}
      </div>

      {confirmDel && (
        <div className="fixed inset-0 z-50 grid place-items-center p-4" style={{ background: 'rgba(3,5,8,0.78)' }} onClick={() => setConfirmDel(null)}>
          <div className="hud-panel p-4 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
            <h3 className="fs-subheading mb-2" style={{ color: '#eaf1f8' }}>删除资产</h3>
            <p className="fs-small mb-4" style={{ color: '#8896a8' }}>确定删除 {confirmDel.host}:{confirmDel.port}?</p>
            <div className="flex justify-end gap-2">
              <button className="btn btn-ghost" onClick={() => setConfirmDel(null)}>取消</button>
              <button
                className="btn btn-danger"
                onClick={async () => {
                  try {
                    await deleteRecord('assets', confirmDel.id);
                    setAssets((prev) => prev.filter((x) => x.id !== confirmDel.id));
                    notify('已删除', 'ok');
                  } catch (e) {
                    notify(e instanceof Error ? e.message : '删除失败', 'err');
                  } finally {
                    setConfirmDel(null);
                  }
                }}
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
