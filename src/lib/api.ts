// ReconLab — 后端接口层（同域 /api，无需跨域）
export const API_BASE = '/api';
const TOKEN_KEY = 'reconlab_token';
const USER_KEY = 'reconlab_user';

export type ID = string;

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  role?: string;
}

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setSession(token: string, user: AuthUser) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch { /* ignore */ }
}
export function clearSession() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch { /* ignore */ }
}
export function cachedUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch { return null; }
}

export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

function buildUrl(path: string, query?: Query): string {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  if (!query) return url;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `${url}?${parts.join('&')}` : url;
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; query?: Query; form?: FormData; raw?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers['Authorization'] = token;
  let body: BodyInit | undefined;
  if (opts.form) {
    body = opts.form;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(buildUrl(path, opts.query), {
    method: opts.method || (body ? 'POST' : 'GET'),
    headers,
    body,
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) {
    if (res.status === 401) clearSession();
    const msg =
      (data && typeof data === 'object' && 'message' in data && typeof (data as { message: unknown }).message === 'string'
        ? (data as { message: string }).message
        : null) || `请求失败 (${res.status})`;
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}

export interface ListResult<T> {
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  items: T[];
}

export async function listRecords<T>(
  collection: string,
  query: Query = {},
): Promise<ListResult<T>> {
  return api<ListResult<T>>(`/collections/${collection}/records`, {
    query: { perPage: 30, sort: '-created', ...query },
  });
}

export async function allRecords<T>(collection: string, query: Query = {}, max = 500): Promise<T[]> {
  const out: T[] = [];
  let page = 1;
  const perPage = 100;
  for (;;) {
    const res = await listRecords<T>(collection, { ...query, page, perPage });
    out.push(...res.items);
    if (page >= res.totalPages || out.length >= max) break;
    page += 1;
    if (page > 12) break;
  }
  return out.slice(0, max);
}

export async function createRecord<T>(collection: string, body: unknown): Promise<T> {
  return api<T>(`/collections/${collection}/records`, { method: 'POST', body });
}

export async function updateRecord<T>(collection: string, id: ID, body: unknown): Promise<T> {
  return api<T>(`/collections/${collection}/records/${id}`, { method: 'PATCH', body });
}

export async function deleteRecord(collection: string, id: ID): Promise<void> {
  await api(`/collections/${collection}/records/${id}`, { method: 'DELETE' });
}

export async function uploadFile<T>(collection: string, id: ID, field: string, file: File): Promise<T> {
  const form = new FormData();
  form.append(field, file);
  return api<T>(`/collections/${collection}/records/${id}`, { method: 'PATCH', form });
}

export const fileUrl = (collection: string, recordId: ID, filename: string) =>
  `${API_BASE}/files/${collection}/${recordId}/${filename}`;

/* ───────────── 认证 ───────────── */

export async function login(identity: string, password: string): Promise<{ token: string; record: AuthUser }> {
  return api<{ token: string; record: AuthUser }>('/collections/users/auth-with-password', {
    method: 'POST',
    body: { identity, password },
  });
}

export async function register(email: string, password: string, name?: string): Promise<AuthUser> {
  return api<AuthUser>('/collections/users/records', {
    method: 'POST',
    body: { email, password, passwordConfirm: password, name: name || email.split('@')[0] },
  });
}

/* ───────────── 数据模型 ───────────── */

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type ScanKind = 'subdomain' | 'port' | 'http' | 'dir' | 'vuln' | 'poc';
export type ScanStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled';
export type FindingStatus = 'new' | 'confirmed' | 'false_positive' | 'fixed';

export interface Target {
  id: ID;
  name: string;
  value: string;
  kind: 'domain' | 'ip' | 'url' | 'cidr';
  scope: 'in' | 'out';
  tags?: string;
  note?: string;
  created: string;
  updated: string;
}

export interface Scan {
  id: ID;
  name: string;
  kind: ScanKind;
  target: ID;
  expand?: { target?: Target };
  args?: Record<string, unknown> | string;
  status: ScanStatus;
  progress: number;
  message?: string;
  log?: string;
  worker?: ID;
  stats?: Record<string, unknown> | string;
  started?: string;
  finished?: string;
  created: string;
  updated: string;
}

export interface Asset {
  id: ID;
  scan?: ID;
  target?: ID;
  host: string;
  port?: number;
  service?: string;
  banner?: string;
  title?: string;
  tech?: string;
  status_code?: number;
  url?: string;
  tls?: string;
  raw?: string;
  created: string;
  updated: string;
}

export interface Finding {
  id: ID;
  target?: ID;
  scan?: ID;
  asset?: ID;
  title: string;
  severity: Severity;
  category?: string;
  url?: string;
  parameter?: string;
  payload?: string;
  request?: string;
  response?: string;
  evidence?: string;
  confidence?: number;
  status: FindingStatus;
  cvss?: number;
  cve?: string;
  poc?: ID;
  created: string;
  updated: string;
}

export interface Poc {
  id: ID;
  name: string;
  category?: string;
  severity: Severity;
  description?: string;
  method?: string;
  path?: string;
  headers?: string;
  body?: string;
  matchers?: string;
  enabled: boolean;
  created: string;
  updated: string;
}

export interface Worker {
  id: ID;
  name: string;
  hostname?: string;
  os?: string;
  version?: string;
  caps?: string;
  status: 'online' | 'idle' | 'offline';
  last_seen?: string;
  current_scan?: string;
  created: string;
  updated: string;
}

export interface Report {
  id: ID;
  title: string;
  target?: ID;
  summary?: string;
  content?: string;
  created: string;
  updated: string;
}

/* ───────────── 复核工作流 ───────────── */

export type ReviewState =
  | 'new' | 'normalized' | 'awaiting_human' | 'auto_verified'
  | 'confirmed' | 'rejected' | 'uncertain' | 'retest';

export type Verdict = 'confirmed' | 'false_positive' | 'uncertain' | 'need_retest';
export type Tier = 'confirmed' | 'suspect' | 'noise';
export type Origin = 'scanner' | 'agent' | 'manual';

export interface ReviewItem {
  id: ID;
  finding?: ID;
  target?: ID;
  scan?: ID;
  rule_id?: string;
  title: string;
  url?: string;
  endpoint?: string;
  endpoint_norm?: string;
  location?: 'query' | 'body' | 'header' | 'cookie' | 'path' | '';
  parameter?: string;
  severity: Severity;
  state: ReviewState;
  origin?: Origin;
  agent_name?: string;
  confidence?: number;
  tier?: Tier;
  dedup_hash?: string;
  instances?: number;
  evidence?: string;
  evidence_ids?: string[] | EvidenceRef[];
  raw_request?: string;
  raw_response?: string;
  curl?: string;
  reproduction_steps?: string[];
  verdict?: Verdict;
  verdict_note?: string;
  fp_pattern?: string;
  checks?: string;
  attempts?: number;
  reviewer?: string;
  verified_at?: string;
  queue_order?: number;
  scope?: ID;
  rev?: number;
  lease_token?: string;
  lease_expires_at?: string;
  claimed_by?: string;
  heartbeat_at?: string;
  supersedes?: ID;
  superseded_by?: ID;
  reopened_reason?: string;
  contract_note?: string;
  created: string;
  updated: string;
}

/** 契约 v2 之后新增的对象 */

export interface EvidenceRef {
  id: ID;
  sha256?: string;
  kind?: string;
  note?: string;
}

export interface ScopeAsset {
  type: 'domain' | 'ip_cidr' | 'url_prefix' | 'ip';
  value: string;
}

export interface ScopeRecord {
  id: ID;
  name: string;
  assets: ScopeAsset[] | string;
  status?: 'active' | 'expired' | 'revoked';
  active?: boolean;
  authorized_at?: string;
  expires_at?: string;
  authorization_reference?: string;
  note?: string;
  created: string;
  updated: string;
}

export interface EvidenceRecord {
  id: ID;
  file?: string;
  sha256?: string;
  size?: number;
  content_type?: string;
  kind?: string;
  note?: string;
  agent_name?: string;
  original_name?: string;
  digest_verified?: boolean;
  hash_method?: string;
  created: string;
  updated: string;
}

export interface RubricRecord {
  id: ID;
  rule_id: string;
  title?: string;
  category?: string;
  enforce?: boolean;
  min_confidence?: number;
  confirm_checks?: string[] | string;
  confirm_evidence_kinds?: string[] | string;
  reject_reasons?: string[] | string;
  inconclusive_triggers?: string[] | string;
  note?: string;
  enabled?: boolean;
  created: string;
  updated: string;
}

/** 契约层用到的角色：仅测试/调试用，正式走 Agent Key */

export interface FpFingerprint {
  id: ID;
  rule_id?: string;
  url_pattern?: string;
  resp_sig?: string;
  reason?: string;
  hits?: number;
  penalty?: number;
  source?: 'human' | 'agent' | 'auto';
  enabled: boolean;
  last_hit?: string;
  created: string;
  updated: string;
}

export interface RuleStat {
  id: ID;
  rule_id: string;
  poc_name?: string;
  hits?: number;
  confirmed?: number;
  rejected?: number;
  uncertain?: number;
  precision?: number;
  state?: 'active' | 'watch' | 'downweighted' | 'retired';
  note?: string;
  created: string;
  updated: string;
}

export interface AgentRecord {
  id: ID;
  name: string;
  identity?: string;
  scopes?: string;
  api_key_hash?: string;
  key_prefix?: string;
  key_created?: string;
  key_last_used?: string;
  status?: 'online' | 'idle' | 'offline' | 'revoked';
  mode?: 'verifier' | 'collector' | 'both';
  ingested?: number;
  verified?: number;
  last_seen?: string;
  note?: string;
  created: string;
  updated: string;
}
