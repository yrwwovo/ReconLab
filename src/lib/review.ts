/**
 * ReconLab 复核引擎
 * ────────────────────────────────────────────────
 * 把"命中即漏洞"的死逻辑换掉，改成多层证伪：
 *   ① 源头降噪   响应归一化 → 稳定指纹 → 软 404 聚类 → 同指纹合并实例
 *   ② 主动证伪   复现 / 反证对照 / 多路交叉 / 带外确认 / WAF 剥离
 *   ③ 交叉验证   多源命中加权，单源降级
 *   ④ 工作流兜底 置信度分档 → 状态机 → 误报指纹库 → 规则精度自动降权
 */

import type { Finding, ReviewItem, ReviewState, Severity, Tier, Verdict, FpFingerprint, RuleStat } from './api';

/* ═════════════ ① 源头降噪：响应归一化 ═════════════ */

const NOISE_RULES: Array<[RegExp, string]> = [
  // 时间戳 / 时钟
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '<TS>'],
  [/\b\d{2}:\d{2}:\d{2}\b/g, '<TIME>'],
  [/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),? \d{1,2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT\b/g, '<HTTPDATE>'],
  [/\b1[5-9]\d{11}\b/g, '<EPOCHMS>'],
  // 随机量 / nonce / token
  [/\b[0-9a-fA-F]{32,}\b/g, '<HEX>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>'],
  [/(?<=["'=: ])[A-Za-z0-9+/]{24,}={0,2}(?=["'< ])/g, '<B64>'],
  [/(name|id|token|nonce|csrf|_csrf|authenticity_token|__RequestVerificationToken)["']?\s*[:=]\s*["']?[A-Za-z0-9_\-+/=.]{8,}["']?/gi, '$1=<TOK>'],
  [/<input[^>]+type=["']hidden["'][^>]*>/gi, '<HIDDEN>'],
  // 会话 / 计数器 / 随机数
  [/\b(?:session|sess|jsessionid|phpsessid|sid|connect\.sid)=[^;"'\s]+/gi, '$1=<SESS>'],
  [/\b\d{13,}\b/g, '<BIGNUM>'],
  [/\b(?:ts|_t|t|timestamp|rand|_)=?\d{6,}\b/gi, '<RAND>'],
  [/<!--[\s\S]*?-->/g, ''],
];

/** 剥掉每次请求都会变的量，留下"稳定骨架" */
export function normalizeResponse(raw?: string): string {
  if (!raw) return '';
  let out = raw;
  for (const [re, rep] of NOISE_RULES) out = out.replace(re, rep);
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

/** k-gram shingle 集合（用于相似度聚类，比长度比对靠谱得多） */
export function shingles(text: string, k = 5, max = 240): Set<number> {
  const tokens = text.split(/[\s>\n<"',;:{}()\[\]=/]+/).filter(Boolean);
  const set = new Set<number>();
  for (let i = 0; i + k <= tokens.length && set.size < max; i += 1) {
    let h = 2166136261;
    const gram = tokens.slice(i, i + k).join(' ');
    for (let j = 0; j < gram.length; j += 1) {
      h ^= gram.charCodeAt(j);
      h = Math.imul(h, 16777619);
    }
    set.add(h >>> 0);
  }
  if (set.size === 0) {
    // 太短的内容退化为单 token 集合
    for (const t of tokens) {
      let h = 2166136261;
      for (let j = 0; j < t.length; j += 1) {
        h ^= t.charCodeAt(j);
        h = Math.imul(h, 16777619);
      }
      set.add(h >>> 0);
    }
  }
  return set;
}

export function jaccard(a: Set<number>, b: Set<number>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  small.forEach((v) => { if (big.has(v)) inter += 1; });
  return inter / (a.size + b.size - inter);
}

export interface RespProfile {
  status?: number;
  length: number;
  lengthBucket: number;
  title: string;
  ct: string;
  sig: string;
}

/** 响应稳定指纹：状态码 + 长度档 + 标题 + 内容类型 + shingle 摘要 */
export function profileResponse(raw?: string, status?: number): RespProfile {
  const statusFromLine = raw ? Number((raw.match(/^HTTP\/[\d.]\s+(\d{3})/) || [])[1]) : NaN;
  if (status === undefined && Number.isFinite(statusFromLine)) status = statusFromLine;
  const norm = normalizeResponse(raw);
  const len = norm.length;
  const titleMatch = norm.match(/<title[^>]*>([^<]{0,120})<\/title>/i);
  const title = (titleMatch ? titleMatch[1] : '').trim().slice(0, 80);
  const ctMatch = norm.match(/content-type["']?\s*[:=]\s*["']?([a-z0-9/+.\-]{3,40})/i);
  const ct = (ctMatch ? ctMatch[1] : '').toLowerCase();
  const bucket = len === 0 ? 0 : Math.round(Math.log10(len) * 4); // 长度按量级分档，抗缓存抖动
  const sample = Array.from(shingles(norm, 5)).sort((a, b) => a - b).slice(0, 24).join(',');
  const sig = `${status ?? '-'}|${bucket}|${title}|${ct}|${hash32(sample)}`;
  return { status, length: len, lengthBucket: bucket, title, ct, sig };
}

function hash32(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function shortHash(s: string, len = 12): string {
  let a = 2166136261;
  let b = 0x9e3779b9;
  for (let i = 0; i < s.length; i += 1) {
    a ^= s.charCodeAt(i); a = Math.imul(a, 16777619);
    b = Math.imul(b ^ s.charCodeAt(i), 2246822519);
  }
  return ((a >>> 0).toString(16) + (b >>> 0).toString(16)).slice(0, len);
}

/* ── 软 404 / 通配响应基线聚类 ── */

export interface BaselineSample { url: string; status?: number; body?: string }

export interface SoftBaseline {
  sigs: RespProfile[];
  /** 判定某响应是否只是"软 404 假象" */
  isSoft: (raw?: string, status?: number) => boolean;
  /** 是否与某个已知基线高度相似（同一模板页糊出来的） */
  similarTo: (raw?: string) => number;
}

export function buildSoftBaseline(samples: BaselineSample[]): SoftBaseline {
  const profiles = samples.map((s) => profileResponse(s.body, s.status));
  const sets = samples.map((s) => shingles(normalizeResponse(s.body)));
  return {
    sigs: profiles,
    isSoft(raw, status) {
      const p = profileResponse(raw, status);
      if (profiles.some((b) => b.sig === p.sig)) return true;
      const set = shingles(normalizeResponse(raw));
      return sets.some((b) => jaccard(b, set) >= 0.82);
    },
    similarTo(raw) {
      const set = shingles(normalizeResponse(raw));
      let best = 0;
      for (const b of sets) best = Math.max(best, jaccard(b, set));
      return best;
    },
  };
}

/** 去重键：规则 + 归一化路径 + 参数位 + 命中位置 */
export function dedupKey(input: { rule_id?: string; url?: string; parameter?: string; category?: string }): string {
  const u = (input.url || '').trim().toLowerCase();
  let path = u;
  let queryKeys = '';
  try {
    const parsed = new URL(u.includes('://') ? u : `http://x/${u.replace(/^\//, '')}`);
    path = parsed.pathname.replace(/\/\d{2,}/g, '/<N>').replace(/\/[0-9a-f]{8,}/gi, '/<ID>');
    queryKeys = Array.from(parsed.searchParams.keys()).sort().join(',');
  } catch {
    path = u.split('?')[0];
  }
  return shortHash(
    [input.rule_id || input.category || '-', path, queryKeys, input.parameter || '-'].join('|'),
    16,
  );
}

export interface DedupGroup<T> { key: string; items: T[]; representative: T }

export function dedupBy<T>(items: T[], keyOf: (item: T) => string): DedupGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = keyOf(item);
    const arr = map.get(k);
    if (arr) arr.push(item); else map.set(k, [item]);
  }
  return Array.from(map.entries()).map(([key, group]) => ({ key, items: group, representative: group[0] }));
}

/* ═════════════ ② 主动证伪：检查项 ═════════════ */

export type CheckId = 'reproduce' | 'control' | 'cross' | 'active' | 'side' | 'waf';

export interface CheckDef {
  id: CheckId;
  label: string;
  detail: string;
  /** 该检查适用的漏洞类别关键词 */
  applies: RegExp;
}

export const CHECKS: CheckDef[] = [
  {
    id: 'reproduce',
    label: '复现',
    detail: '同请求重复 ≥2 次，结果稳定一致（时间类取中位数，抖动超阈值判不稳定）',
    applies: /.*/,
  },
  {
    id: 'control',
    label: '反证对照',
    detail: '对不存在的路径 / 不存在的参数做同样请求，响应与命中不同 → 排除软 404 假象',
    applies: /.*/,
  },
  {
    id: 'cross',
    label: '多路交叉',
    detail: '布尔 / 报错 / 时间 三路中至少两路一致；三路冲突直接降级',
    applies: /sql|注入|injection/i,
  },
  {
    id: 'active',
    label: '主动确认',
    detail: 'XSS 走无头浏览器 DOM 侧确认；盲注取统计显著；SSRF/RCE 走带外回连',
    applies: /xss|script|注入|injection|ssrf|rce|盲注|blind/i,
  },
  {
    id: 'side',
    label: '旁证',
    detail: '版本号 / 路由存在性(405、OPTIONS) / 响应差异只出现在预期位置',
    applies: /.*/,
  },
  {
    id: 'waf',
    label: 'WAF 剥离',
    detail: '被 WAF 拦下的响应要单独标出——那是拦截，不是漏洞',
    applies: /.*/,
  },
];

export type CheckState = 'pass' | 'fail' | 'todo' | 'na';

export interface CheckResult { id: CheckId; state: CheckState; note?: string }

const CHECK_WEIGHT: Record<CheckId, { pass: number; fail: number }> = {
  reproduce: { pass: 18, fail: -20 },
  control: { pass: 16, fail: -26 },
  cross: { pass: 16, fail: -18 },
  active: { pass: 20, fail: -16 },
  side: { pass: 8, fail: -4 },
  waf: { pass: 0, fail: -14 },
};

export function parseChecks(raw?: string): CheckResult[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as CheckResult[];
  } catch { /* 兼容 "reproduce=pass;control=fail" */
    return raw.split(/[;,]/).map((piece) => {
      const [id, state, ...rest] = piece.split('=');
      return { id: (id || '').trim() as CheckId, state: (state || 'todo').trim() as CheckState, note: rest.join('=').trim() };
    }).filter((c) => c.id);
  }
  return [];
}

export function serializeChecks(checks: CheckResult[]): string {
  return JSON.stringify(checks);
}

export function applicableChecks(input: { title?: string; category?: string; rule_id?: string }): CheckDef[] {
  const hay = `${input.title || ''} ${input.category || ''} ${input.rule_id || ''}`;
  return CHECKS.filter((c) => c.applies.test(hay));
}

/** 分数 → 分档（阈值只此一处，别在别处再写一遍） */
export function tierOfScore(score: number): Tier {
  return score >= 75 ? 'confirmed' : score >= 45 ? 'suspect' : 'noise';
}

/** 置信度引擎 */
export interface ConfidenceResult {
  score: number;
  tier: Tier;
  reasons: string[];
  penalties: string[];
}

export function computeConfidence(input: {
  checks: CheckResult[];
  severity?: Severity;
  sources?: number;
  fpHits?: Array<{ rule_id?: string; resp_sig?: string; penalty?: number; reason?: string }>;
  wafBlocked?: boolean;
}): ConfidenceResult {
  const reasons: string[] = [];
  const penalties: string[] = [];
  let score = 18; // 基线：仅"命中"，还不能说明什么

  for (const check of input.checks) {
    const weight = CHECK_WEIGHT[check.id];
    if (!weight || check.state === 'todo' || check.state === 'na') continue;
    if (check.state === 'pass') {
      score += weight.pass;
      reasons.push(`${check.id} 通过 +${weight.pass}`);
    } else {
      score += weight.fail;
      penalties.push(`${check.id} 失败 ${weight.fail}`);
    }
  }

  const missing = input.checks.filter((c) => c.state === 'todo').length;
  if (missing > 0) penalties.push(`尚有 ${missing} 项未验证`);

  const sources = input.sources ?? 1;
  if (sources >= 2) { score += 10; reasons.push(`多源交叉命中 +10`); }
  else { score -= 8; penalties.push('单源命中 -8'); }

  if (input.severity === 'critical' || input.severity === 'high') {
    score -= 6;
    penalties.push('高危结论从严 -6');
  }

  for (const fp of input.fpHits || []) {
    const pen = fp.penalty ?? 25;
    score -= pen;
    penalties.push(`误报指纹命中(${fp.rule_id || '-'} / ${fp.resp_sig || '-'}) -${pen}`);
  }

  if (input.wafBlocked) {
    score -= 14;
    penalties.push('响应疑似被 WAF 拦截 -14');
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, tier: tierOfScore(score), reasons, penalties };
}

export const TIER_META: Record<Tier, { label: string; hint: string; tone: 'ok' | 'warn' | 'bad' }> = {
  confirmed: { label: '已确认', hint: '证据链完整、可控复现', tone: 'ok' },
  suspect: { label: '待复核', hint: '命中但缺关键证伪步骤', tone: 'warn' },
  noise: { label: '疑似', hint: '跟软 404 / 指纹库高度重合', tone: 'bad' },
};

/* ═════════════ ④ 工作流兜底：状态机 ═════════════ */

export const REVIEW_STATES: ReviewState[] = [
  'new', 'normalized', 'awaiting_human', 'auto_verified', 'confirmed', 'rejected', 'uncertain', 'retest',
];

export const STATE_META: Record<ReviewState, { label: string; tone: 'ok' | 'warn' | 'bad' | 'idle'; desc: string }> = {
  new: { label: '新发现', tone: 'idle', desc: '刚入库，未做降噪' },
  normalized: { label: '已降噪', tone: 'idle', desc: '响应归一化 + 指纹聚类完成' },
  awaiting_human: { label: '待人工', tone: 'warn', desc: '自动证伪跑完，等人工判定' },
  auto_verified: { label: '自动确认', tone: 'warn', desc: 'Agent 独立复现过，等人工签字' },
  confirmed: { label: '已确认', tone: 'ok', desc: '进报告主文' },
  rejected: { label: '已驳回', tone: 'bad', desc: '误报，指纹已入误报库' },
  uncertain: { label: '存疑', tone: 'warn', desc: '证据不足，进报告附录' },
  retest: { label: '待复测', tone: 'warn', desc: '环境变更后需重新验证' },
};

const TRANSITIONS: Record<ReviewState, ReviewState[]> = {
  new: ['normalized', 'awaiting_human', 'rejected'],
  normalized: ['awaiting_human', 'auto_verified', 'rejected'],
  awaiting_human: ['confirmed', 'rejected', 'uncertain', 'retest'],
  auto_verified: ['confirmed', 'rejected', 'uncertain'],
  confirmed: ['retest', 'rejected'],
  rejected: ['retest'],
  uncertain: ['confirmed', 'rejected', 'retest'],
  retest: ['awaiting_human', 'confirmed', 'rejected'],
};

export function nextStates(state: ReviewState): ReviewState[] {
  return TRANSITIONS[state] || [];
}

export function canTransition(from: ReviewState, to: ReviewState): boolean {
  return nextStates(from).includes(to);
}

export function verdictToState(verdict: Verdict): ReviewState {
  switch (verdict) {
    case 'confirmed': return 'confirmed';
    case 'false_positive': return 'rejected';
    case 'need_retest': return 'retest';
    default: return 'uncertain';
  }
}

/* ── 误报指纹 ── */

export function fingerprintOf(item: {
  rule_id?: string; url?: string; raw_response?: string; category?: string;
}): { rule_id: string; url_pattern: string; resp_sig: string } {
  const ruleId = item.rule_id || item.category || 'unknown';
  let pattern = item.url || '*';
  try {
    const parsed = new URL((item.url || '').includes('://') ? item.url! : `http://x${item.url || '/'}`);
    const segs = parsed.pathname.split('/').filter(Boolean).map((s) => (/\d/.test(s) ? '*' : s));
    pattern = `${parsed.host}${segs.length ? `/${segs.join('/')}` : '/'}${parsed.search ? '?*' : ''}`;
  } catch { /* 保持原样 */ }
  const prof = profileResponse(item.raw_response);
  return { rule_id: ruleId, url_pattern: pattern, resp_sig: prof.sig };
}

export function fpMatch(
  item: { rule_id?: string; url?: string; raw_response?: string; category?: string },
  fingerprints: FpFingerprint[],
): FpFingerprint[] {
  const fp = fingerprintOf(item);
  return fingerprints.filter((f) => {
    if (f.enabled === false) return false;
    if (f.rule_id && fp.rule_id && f.rule_id !== fp.rule_id) return false;
    const sigHit = !!f.resp_sig && f.resp_sig === fp.resp_sig;
    const urlHit = !!f.url_pattern && (f.url_pattern === fp.url_pattern || matchesWildcard(f.url_pattern, fp.url_pattern));
    return sigHit || urlHit;
  });
}

function matchesWildcard(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern === value;
  const rx = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return rx.test(value);
}

/* ── 规则精度 ── */

export const RULE_STATE_META: Record<NonNullable<RuleStat['state']>, { label: string; tone: 'ok' | 'warn' | 'bad' | 'idle'; desc: string }> = {
  active: { label: '在用', tone: 'ok', desc: '精度达标，正常参与扫描' },
  watch: { label: '观察', tone: 'idle', desc: '样本不足，继续累积' },
  downweighted: { label: '已降权', tone: 'warn', desc: '精度偏低，置信度自动打折' },
  retired: { label: '已下线', tone: 'bad', desc: '精度太烂，停止上报' },
};

export function computePrecision(hits: number, confirmed: number): number {
  if (hits <= 0) return 0;
  return Math.round((confirmed / hits) * 1000) / 10;
}

export function ruleStateFor(hits: number, precision: number): NonNullable<RuleStat['state']> {
  if (hits < 5) return 'watch';
  if (precision >= 70) return 'active';
  if (precision >= 40) return 'downweighted';
  return 'retired';
}

/** 规则降权折算成置信度惩罚 */
export function rulePenalty(stat?: RuleStat): number {
  if (!stat) return 0;
  if (stat.state === 'retired') return 30;
  if (stat.state === 'downweighted') return 15;
  if (stat.state === 'watch') return 4;
  return 0;
}

/* ═════════════ 可复现证据：curl ═════════════ */

export interface ParsedRequest {
  method: string;
  path: string;
  headers: [string, string][];
  body?: string;
}

export function parseRawRequest(raw?: string): ParsedRequest | null {
  if (!raw || !raw.trim()) return null;
  const lines = raw.replace(/\r/g, '').split('\n');
  const first = lines[0]?.trim();
  if (!first) return null;
  const m = first.match(/^([A-Z]{3,7})\s+(\S+)\s*(HTTP\/[\d.]+)?$/);
  if (!m) return null;
  const headers: [string, string][] = [];
  let i = 1;
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) { i += 1; break; }
    const idx = line.indexOf(':');
    if (idx > 0) headers.push([line.slice(0, idx).trim(), line.slice(idx + 1).trim()]);
  }
  const body = lines.slice(i).join('\n').trim() || undefined;
  return { method: m[1], path: m[2], headers, body };
}

const SKIP_HEADERS = /^(host|content-length|connection|cookie|authorization)$/i;

export function buildCurl(input: { url?: string; request?: string; raw_request?: string; payload?: string }): string {
  const raw = input.raw_request || input.request;
  const parsed = parseRawRequest(raw);
  let url = input.url || '';
  const parts: string[] = ['curl -isk'];
  if (parsed) {
    parts.push(`-X ${parsed.method}`);
    if (!url) url = parsed.path;
    for (const [k, v] of parsed.headers) {
      if (SKIP_HEADERS.test(k)) continue;
      parts.push(`-H '${k}: ${v.replace(/'/g, "'\\''")}'`);
    }
    if (parsed.body) parts.push(`--data-raw '${parsed.body.replace(/'/g, "'\\''")}'`);
  } else if (input.payload) {
    parts.push(`--data-raw '${input.payload.replace(/'/g, "'\\''")}'`);
  }
  parts.push(`'${url || 'http://TARGET'}'`);
  return parts.join(' ');
}

/* ═════════════ 报告分级 ═════════════ */

export interface ReportBundle {
  main: ReviewItem[];
  appendix: ReviewItem[];
  rejected: ReviewItem[];
  stats: { total: number; confirmed: number; suspect: number; noise: number; precision: number };
}

export function splitForReport(items: ReviewItem[]): ReportBundle {
  const main = items.filter((i) => i.state === 'confirmed');
  const rejected = items.filter((i) => i.state === 'rejected');
  const rest = items.filter((i) => i.state !== 'confirmed' && i.state !== 'rejected');
  const appendix = rest.filter((i) => (i.tier ?? 'suspect') !== 'noise' || i.state === 'uncertain' || i.state === 'retest');
  const noise = rest.filter((i) => !appendix.includes(i));
  const hits = items.length;
  return {
    main, appendix, rejected,
    stats: {
      total: hits,
      confirmed: main.length,
      suspect: appendix.length,
      noise: noise.length,
      precision: computePrecision(hits, main.length),
    },
  };
}

export function severityRank(s: Severity): number {
  return ({ critical: 5, high: 4, medium: 3, low: 2, info: 1 } as Record<Severity, number>)[s] || 0;
}

export function findingToQueueItem(f: Finding, opts: { ruleId?: string; origin?: ReviewItem['origin']; agentName?: string } = {}): Partial<ReviewItem> {
  return {
    finding: f.id,
    target: f.target,
    scan: f.scan,
    rule_id: opts.ruleId || f.category || f.title,
    title: f.title,
    url: f.url,
    parameter: f.parameter,
    severity: f.severity,
    state: 'new',
    origin: opts.origin || 'scanner',
    agent_name: opts.agentName,
    evidence: f.evidence,
    raw_request: f.request,
    raw_response: f.response,
    curl: buildCurl({ url: f.url, request: f.request, payload: f.payload }),
    confidence: f.confidence ?? 20,
    attempts: 1,
    dedup_hash: dedupKey({ rule_id: opts.ruleId || f.category, url: f.url, parameter: f.parameter }),
  };
}

/* ── 时间盲注统计判据（前端展示用，实际采样在执行器侧） ── */

export function blindTimingVerdict(samples: number[], baseline: number[]): {
  ok: boolean;
  median: number;
  baseMedian: number;
  jitter: number;
  delta: number;
  note: string;
} {
  const med = (arr: number[]) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const median = med(samples);
  const baseMedian = med(baseline);
  const mean = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
  const jitter = samples.length > 1
    ? Math.sqrt(samples.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (samples.length - 1))
    : 0;
  const delta = median - baseMedian;
  const need = Math.max(2.0, jitter * 3 + 1.0);
  const ok = samples.length >= 3 && delta >= need;
  return {
    ok, median, baseMedian, jitter, delta,
    note: ok
      ? `中位数延迟 ${median.toFixed(2)}s 较基线 +${delta.toFixed(2)}s，抖动 ${jitter.toFixed(2)}s，达显著阈`
      : `未达显著阈（需 ≥${need.toFixed(2)}s 且样本 ≥3，实测 +${delta.toFixed(2)}s，抖动 ${jitter.toFixed(2)}s）`,
  };
}
