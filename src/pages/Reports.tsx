import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { FileText, Download, Trash2, Sparkles, Eye, Printer } from 'lucide-react';
import { allRecords, createRecord, deleteRecord, type Asset, type Finding, type Report, type ReviewItem, type Severity, type Target } from '../lib/api';
import { CopyButton, EmptyState, Modal, Select, SEVERITY_META, Spinner, fmtTime, notify } from '../components/kit';

const SEV_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

const FIX_ADVICE: Record<Severity, string> = {
  critical: '立即处置:在修复完成前建议临时下线相关入口或加访问控制。',
  high: '尽快修复:建议本周内完成,并复核同类接口是否存在相同问题。',
  medium: '计划修复:排入下一个迭代,修复后回归验证。',
  low: '建议改进:结合其他加固工作一并处理。',
  info: '信息参考:不影响直接利用,可作为资产梳理依据。',
};

function buildReport(target: Target, assets: Asset[], findings: Finding[], queue: ReviewItem[], operator: string): string {
  const qByFinding = new Map<string, ReviewItem>();
  for (const q of queue) if (q.finding) qByFinding.set(q.finding, q);
  /** 主文口径：过了复核状态机的已确认条目才算数；没走复核的老数据退回按 finding.status 判 */
  const isConfirmed = (f: Finding) => {
    const q = qByFinding.get(f.id);
    return q ? q.state === 'confirmed' : f.status === 'confirmed';
  };
  const reviewOf = (f: Finding) => qByFinding.get(f.id);
  const sevCount: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) sevCount[f.severity] = (sevCount[f.severity] || 0) + 1;
  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  const confirmed = findings.filter(isConfirmed);
  const rejected = findings.filter((f) => {
    const q = qByFinding.get(f.id);
    return q ? q.state === 'rejected' : f.status === 'false_positive';
  });
  const appendixed = findings.filter((f) => !confirmed.includes(f) && !rejected.includes(f));
  const inScope = confirmed;

  const lines: string[] = [];
  lines.push(`# ${target.name || target.value} 安全测试报告`);
  lines.push('');
  lines.push(`> 报告生成时间:${now}　|　执行人:${operator}　|　目标值:${target.value}`);
  lines.push('');
  lines.push('## 一、测试概述');
  lines.push('');
  lines.push(`- 测试目标:${target.name || target.value}(${target.kind})`);
  lines.push(`- 授权范围:${target.scope === 'in' ? '已登记为授权范围内目标' : '范围外目标(仅登记)'}`);
  lines.push(`- 资产数量:${assets.length} 条`);
  lines.push(`- 命中记录:${findings.length} 条`);
  lines.push(`- **已确认漏洞:${confirmed.length} 条**(经复核状态机确认,构成本报告主文)`);
  lines.push(`- 待复核/存疑:${appendixed.length} 条(证据链不完整,列入附录 A,不计入结论)`);
  lines.push(`- 已驳回误报:${rejected.length} 条(误报指纹已入库,后续同指纹自动降权)`);
  lines.push('');
  if (queue.length) {
    const avg = Math.round(queue.reduce((acc, q) => acc + (q.confidence || 0), 0) / queue.length);
    lines.push(`- 复核流水线:共处理 ${queue.length} 条,平均置信度 ${avg} 分(阈值 75 进主文 / 45 以下列疑似)`);
    lines.push('');
  }
  lines.push('## 二、风险概览');
  lines.push('');
  lines.push('| 等级 | 数量 |');
  lines.push('| --- | --- |');
  for (const s of SEV_ORDER) lines.push(`| ${SEVERITY_META[s].label} | ${sevCount[s] || 0} |`);
  lines.push('');
  lines.push('## 三、资产清单');
  lines.push('');
  if (assets.length === 0) {
    lines.push('本次未采集到资产记录。');
  } else {
    lines.push('| 主机 | 端口 | 服务 | 状态码 | 标题/技术栈 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const a of assets.slice(0, 100)) {
      lines.push(`| ${a.host} | ${a.port ?? '-'} | ${a.service || '-'} | ${a.status_code ?? '-'} | ${(a.title || a.tech || '-').replace(/\|/g, '/')} |`);
    }
    if (assets.length > 100) lines.push(`\n> 资产较多,此处仅列出前 100 条,完整清单见资产页导出。`);
  }
  lines.push('');
  lines.push('## 四、漏洞详情');
  lines.push('');
  if (inScope.length === 0) {
    lines.push('本次未发现已确认漏洞。');
  } else {
    let idx = 0;
    for (const s of SEV_ORDER) {
      const group = inScope.filter((f) => f.severity === s);
      if (group.length === 0) continue;
      lines.push(`### 4.${SEV_ORDER.indexOf(s) + 1} ${SEVERITY_META[s].label}(${group.length} 条)`);
      lines.push('');
      for (const f of group) {
        idx += 1;
        lines.push(`#### ${idx}. ${f.title}`);
        lines.push('');
        if (f.url) lines.push(`- 位置:${f.url}`);
        if (f.category) lines.push(`- 分类:${f.category}`);
        if (f.parameter) lines.push(`- 参数:${f.parameter}`);
        if (f.payload) lines.push(`- Payload:\`${f.payload}\``);
        if (f.cve) lines.push(`- 关联编号:${f.cve}`);
        if (f.confidence != null) lines.push(`- 置信度:${Math.round(f.confidence * 100)}%`);
        lines.push(`- 验证状态:${f.status === 'confirmed' ? '已确认' : f.status === 'fixed' ? '已修复' : '待验证'}`);
        {
          const q = reviewOf(f);
          if (q) {
            lines.push(`- 置信度:${q.confidence ?? '-'} 分 / 分档 ${q.tier === 'confirmed' ? '已确认' : q.tier === 'suspect' ? '待复核' : '疑似'}`);
            if (q.verdict_note) lines.push(`- 复核结论:${q.verdict_note}`);
            if (q.agent_name) lines.push(`- 复核来源:${q.origin === 'agent' ? `Agent(${q.agent_name})` : q.origin === 'manual' ? '人工' : '扫描器'}`);
          }
        }
        if (f.evidence) lines.push(`- 判定依据:${f.evidence}`);
        {
          const q = reviewOf(f);
          if (q?.curl) {
            lines.push('');
            lines.push('复现命令:');
            lines.push('```bash');
            lines.push(q.curl);
            lines.push('```');
          }
        }
        if (f.request) {
          lines.push('');
          lines.push('请求:');
          lines.push('```http');
          lines.push(f.request.slice(0, 1200));
          lines.push('```');
        }
        if (f.response) {
          lines.push('');
          lines.push('响应(截断):');
          lines.push('```');
          lines.push(f.response.slice(0, 800));
          lines.push('```');
        }
        lines.push('');
        lines.push(`> 修复建议:${FIX_ADVICE[s]}`);
        lines.push('');
      }
    }
  }
  lines.push('## 五、附录 A · 待复核与存疑条目');
  lines.push('');
  lines.push('以下条目命中规则但证据链不完整（缺主动证伪 / 多路交叉），**不计入本报告结论**，供后续跟进：');
  lines.push('');
  if (appendixed.length === 0) {
    lines.push('无。');
  } else {
    lines.push('| # | 标题 | 位置 | 等级 | 置信度 | 当前状态 | 缺什么 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    appendixed.slice(0, 120).forEach((f, i) => {
      const q = reviewOf(f);
      const missing = (q?.checks || '').includes('todo') ? '尚有检查项未验证' : '未走完复核状态机';
      lines.push(`| ${i + 1} | ${f.title.replace(/\|/g, '/')} | ${(f.url || '-').replace(/\|/g, '/')} | ${SEVERITY_META[f.severity].label} | ${q?.confidence ?? '-'} | ${q ? q.state : '未入队'} | ${missing} |`);
    });
  }
  lines.push('');
  lines.push('## 六、附录 B · 已驳回误报与处置');
  lines.push('');
  if (rejected.length === 0) {
    lines.push('无。');
  } else {
    lines.push('| # | 规则 | 位置 | 响应指纹 | 驳回原因 |');
    lines.push('| --- | --- | --- | --- | --- |');
    rejected.slice(0, 120).forEach((f, i) => {
      const q = reviewOf(f);
      lines.push(`| ${i + 1} | ${(q?.rule_id || f.category || '-').replace(/\|/g, '/')} | ${(f.url || '-').replace(/\|/g, '/')} | ${q?.fp_pattern || '-'} | ${(q?.verdict_note || '人工判定为误报').replace(/\|/g, '/')} |`);
    });
    lines.push('');
    lines.push('> 以上指纹已写入误报指纹库，同规则 + 同 URL 形态 + 同响应骨架再次命中时置信度自动打折。');
  }
  lines.push('');
  lines.push('## 七、处置优先级');
  lines.push('');
  if ((sevCount.critical || 0) + (sevCount.high || 0) > 0) {
    lines.push('1. 优先修复严重/高危问题,修复前对相关入口做临时访问限制。');
    lines.push('2. 对同类接口做横向排查,避免同一类问题在别处复现。');
    lines.push('3. 修复完成后重新执行对应验证任务,确认问题闭环。');
  } else if (findings.length > 0) {
    lines.push('1. 按中危 → 低危顺序排期修复。');
    lines.push('2. 结合安全基线对全站做一次配置加固。');
  } else {
    lines.push('本次未发现有效问题,建议保持定期复测。');
  }
  lines.push('');
  lines.push('## 八、说明');
  lines.push('');
  lines.push('- 本报告仅覆盖已授权范围内目标,所有验证均在授权前提下执行。');
  lines.push('- 报告中的证据为执行器原始回显,可按需复核。');
  lines.push('- 建议每季度或每次重大变更后复测一次。');
  lines.push('');
  return lines.join('\n');
}

function renderMarkdown(md: string) {
  const out: ReactNode[] = [];
  const lines = md.split('\n');
  let inCode = false;
  let codeBuf: string[] = [];
  let listBuf: string[] = [];

  const flushList = () => {
    if (listBuf.length === 0) return;
    out.push(
      <ul key={`ul-${out.length}`} style={{ margin: '0.3rem 0 0.6rem', paddingLeft: '1.1rem' }}>
        {listBuf.map((li, i) => <li key={i} className="fs-small" style={{ color: '#c9d4e0' }}>{li}</li>)}
      </ul>,
    );
    listBuf = [];
  };

  lines.forEach((raw, i) => {
    if (raw.trim().startsWith('```')) {
      if (inCode) {
        out.push(<pre key={`code-${i}`} className="terminal" style={{ margin: '0.4rem 0 0.8rem' }}>{codeBuf.join('\n')}</pre>);
        codeBuf = [];
        inCode = false;
      } else {
        flushList();
        inCode = true;
      }
      return;
    }
    if (inCode) { codeBuf.push(raw); return; }
    if (raw.startsWith('#### ')) { flushList(); out.push(<h4 key={i} className="fs-small font-semibold mt-3" style={{ color: '#e8fff3' }}>{raw.slice(5)}</h4>); return; }
    if (raw.startsWith('### ')) { flushList(); out.push(<h3 key={i} className="fs-subheading mt-4" style={{ color: '#00ff88' }}>{raw.slice(4)}</h3>); return; }
    if (raw.startsWith('## ')) { flushList(); out.push(<h2 key={i} className="fs-heading mt-5 mb-1" style={{ color: '#e8fff3' }}>{raw.slice(3)}</h2>); return; }
    if (raw.startsWith('# ')) { flushList(); out.push(<h1 key={i} className="fs-display mb-2" style={{ color: '#e8fff3' }}>{raw.slice(2)}</h1>); return; }
    if (raw.startsWith('> ')) { flushList(); out.push(<blockquote key={i} className="fs-small my-2 pl-3" style={{ color: '#7d9b8a', borderLeft: '2px solid rgba(34,227,160,0.4)' }}>{raw.slice(2)}</blockquote>); return; }
    if (raw.startsWith('- ')) { listBuf.push(raw.slice(2)); return; }
    if (/^\d+\.\s/.test(raw)) { listBuf.push(raw.replace(/^\d+\.\s/, '')); return; }
    if (raw.startsWith('|')) { flushList(); out.push(<div key={i} className="fs-tiny font-mono" style={{ color: '#7d9b8a' }}>{raw}</div>); return; }
    if (!raw.trim()) { flushList(); return; }
    flushList();
    out.push(<p key={i} className="fs-small my-1.5" style={{ color: '#c9d4e0' }}>{raw}</p>);
  });
  flushList();
  if (inCode && codeBuf.length) out.push(<pre key="code-tail" className="terminal">{codeBuf.join('\n')}</pre>);
  return out;
}

export function ReportsPage() {
  const [loading, setLoading] = useState(true);
  const [targets, setTargets] = useState<Target[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [targetId, setTargetId] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Report | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [tList, rList] = await Promise.all([
          allRecords<Target>('targets', { perPage: 100, sort: '-created', fields: 'id,name,value,kind,scope,tags,note' }, 300),
          allRecords<Report>('reports', { sort: '-created', perPage: 50, fields: 'id,title,target,summary,created' }, 200),
        ]);
        if (!alive) return;
        setTargets(tList);
        setReports(rList);
      } catch (e) {
        notify(e instanceof Error ? e.message : '加载失败', 'err');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const targetMap = useMemo(() => new Map(targets.map((t) => [t.id, t])), [targets]);

  const generate = async () => {
    if (!targetId) { notify('先选一个目标', 'err'); return; }
    const target = targetMap.get(targetId);
    if (!target) return;
    setBusy(true);
    try {
      const [assets, findings, queue] = await Promise.all([
        allRecords<Asset>('assets', { filter: `target="${targetId}"`, perPage: 100 }, 500),
        allRecords<Finding>('findings', { filter: `target="${targetId}"`, perPage: 100 }, 500),
        allRecords<ReviewItem>('review_queue', { filter: `target="${targetId}"`, perPage: 200 }, 600).catch(() => [] as ReviewItem[]),
      ]);
      const content = buildReport(target, assets, findings, queue, 'ReconLab 执行器');
      const title = `${target.name || target.value} 安全测试报告`;
      const created = await createRecord<Report>('reports', {
        title,
        target: targetId,
        summary: `资产 ${assets.length} 条 · 确认 ${findings.filter((f) => f.status === 'confirmed').length} 条 · 队列 ${queue.length} 条`,
        content,
      });
      setReports((prev) => [{ ...created, content: undefined } as Report, ...prev]);
      setPreview(created);
      notify('报告已生成', 'ok');
    } catch (e) {
      notify(e instanceof Error ? e.message : '生成失败', 'err');
    } finally {
      setBusy(false);
    }
  };

  const loadFull = async (r: Report) => {
    try {
      const full = await fetch(`/api/collections/reports/records/${r.id}`, {
        headers: { Authorization: localStorage.getItem('reconlab_token') || '' },
      }).then((res) => res.json() as Promise<Report>);
      setPreview(full);
    } catch {
      notify('读取报告失败', 'err');
    }
  };

  const downloadMd = (r: Report) => {
    const blob = new Blob([r.content || ''], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${r.title}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadHtml = (r: Report) => {
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${r.title}</title>
<style>body{font-family:-apple-system,"Microsoft YaHei",sans-serif;max-width:860px;margin:40px auto;padding:0 20px;line-height:1.7;color:#1a1a1a}
h1{border-bottom:2px solid #22a37a;padding-bottom:8px}h2{margin-top:32px;color:#0d5c46}h3{color:#333}
pre{background:#f5f7f8;padding:12px;border-radius:6px;overflow-x:auto;font-size:12px;border-left:3px solid #22a37a}
code{font-family:Consolas,monospace}table{border-collapse:collapse;width:100%;font-size:13px;margin:12px 0}
td,th{border:1px solid #ddd;padding:6px 8px;text-align:left}blockquote{color:#666;border-left:3px solid #ccc;margin:12px 0;padding-left:12px}
@media print{body{margin:0}}</style></head><body>
${(r.content || '').split('\n').map((l) => {
      if (l.startsWith('#### ')) return `<h4>${l.slice(5)}</h4>`;
      if (l.startsWith('### ')) return `<h3>${l.slice(4)}</h3>`;
      if (l.startsWith('## ')) return `<h2>${l.slice(3)}</h2>`;
      if (l.startsWith('# ')) return `<h1>${l.slice(2)}</h1>`;
      if (l.startsWith('> ')) return `<blockquote>${l.slice(2)}</blockquote>`;
      if (l.startsWith('- ')) return `<li>${l.slice(2)}</li>`;
      if (l.startsWith('```')) return '';
      if (!l.trim()) return '';
      return `<p>${l}</p>`;
    }).join('\n')}
</body></html>`;
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${r.title}.html`;
    a.click();
    URL.revokeObjectURL(url);
    notify('已导出 HTML,浏览器打开后可直接打印成 PDF', 'ok');
  };

  if (loading) return <Spinner label="正在拉取报告…" />;

  return (
    <div className="section-wrap">
      <div className="container-fluid flex flex-col" style={{ gap: 'var(--gap-fluid)' }}>
        <div className="hud-panel p-4">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles size={15} style={{ color: '#00ff88' }} />
            <span className="fs-subheading" style={{ color: '#e8fff3' }}>生成中文测试报告</span>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[200px]">
              <label className="field-label">选择目标</label>
              <Select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                <option value="">— 选择目标 —</option>
                {targets.map((t) => <option key={t.id} value={t.id}>{t.name || t.value} ({t.value})</option>)}
              </Select>
            </div>
            <button className="btn btn-primary" disabled={busy || !targetId} onClick={generate}>
              {busy ? '生成中…' : '生成报告'}
            </button>
          </div>
          <div className="fs-tiny mt-2" style={{ color: '#4e6b5c' }}>
            报告自动汇总该目标下的资产清单与全部发现,按严重度分级,带原始证据与修复建议。
          </div>
        </div>

        {reports.length === 0 ? (
          <div className="hud-panel">
            <EmptyState icon={<FileText size={30} />} title="还没有报告" desc="选一个目标点「生成报告」,几秒出稿。" />
          </div>
        ) : (
          <div className="flex flex-col" style={{ gap: 'var(--gap-fluid)' }}>
            {reports.map((r) => (
              <div key={r.id} className="hud-panel hud-panel-hover p-3.5 flex flex-wrap items-center gap-3 min-w-0">
                <div className="grid place-items-center shrink-0" style={{ width: 34, height: 34, borderRadius: 5, background: 'rgba(34,227,160,0.08)', border: '1px solid rgba(34,227,160,0.24)', color: '#00ff88' }}>
                  <FileText size={17} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="fs-small font-medium truncate" style={{ color: '#e8fff3' }}>{r.title}</div>
                  <div className="fs-tiny truncate" style={{ color: '#4e6b5c' }}>
                    {r.target ? (targetMap.get(r.target)?.value || '—') : '—'} · {r.summary || ''} · {fmtTime(r.created)}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button className="btn btn-ghost !py-1 !px-2" onClick={() => void loadFull(r)}><Eye size={12} /><span className="fs-tiny">预览</span></button>
                  <button className="btn btn-danger !py-1 !px-2" onClick={async () => {
                    try {
                      await deleteRecord('reports', r.id);
                      setReports((prev) => prev.filter((x) => x.id !== r.id));
                      notify('已删除', 'ok');
                    } catch (e) { notify(e instanceof Error ? e.message : '删除失败', 'err'); }
                  }}><Trash2 size={12} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal
        open={!!preview}
        onClose={() => setPreview(null)}
        title={preview?.title || '报告预览'}
        wide
        footer={preview ? (
          <>
            <CopyButton text={preview.content || ''} label="复制全文" />
            <button className="btn btn-ghost" onClick={() => downloadMd(preview)}><Download size={13} />下载 Markdown</button>
            <button className="btn btn-primary" onClick={() => downloadHtml(preview)}><Printer size={13} />导出 HTML / PDF</button>
          </>
        ) : null}
      >
        {preview && (
          <div className="min-w-0">
            {renderMarkdown(preview.content || '')}
          </div>
        )}
      </Modal>
    </div>
  );
}
