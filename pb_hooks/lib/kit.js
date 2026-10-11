/**
 * ReconLab 契约层 · 公共工具
 *
 * 注意（JSVM 特性，踩过的坑）：
 *   1. pb_hooks 里注册的 router handler **不共享文件顶层作用域**，
 *      所以每个 handler 内部都必须自己 require 一次本模块。
 *   2. 路由参数用 Go 1.22 ServeMux 的 `{name}` 语法，
 *      取值走 `c.request.pathValue("name")`，不是 c.pathParam。
 *   3. 请求解析走 `c.requestInfo()`（query / headers / body 都在里面）。
 *   4. 自定义响应头必须先 `c.response.header().set(k, v)` 再 c.json()。
 *   5. 同一个 method+path 重复注册会让进程 panic，路由表只能注册一次。
 */

const CONTRACT_VERSION = 2;

/** 对外契约词表（PhantomVeil 只认这 5 个） */
const EXTERNAL_STATES = ['suspected', 'testing', 'confirmed', 'rejected', 'inconclusive'];

/** 站内复核机词表（人类复核位保留在这套里） */
const INTERNAL_STATES = ['new', 'normalized', 'awaiting_human', 'auto_verified',
  'confirmed', 'rejected', 'uncertain', 'retest'];

/** 内部状态机的合法迁移（与前端 src/lib/review.ts 的 TRANSITIONS 对齐，契约层额外放行两条） */
const TRANSITIONS = {
  new: ['normalized', 'awaiting_human', 'rejected'],
  normalized: ['awaiting_human', 'auto_verified', 'rejected'],
  awaiting_human: ['confirmed', 'rejected', 'uncertain', 'retest', 'auto_verified'],
  auto_verified: ['confirmed', 'rejected', 'uncertain', 'retest'],
  confirmed: ['retest', 'rejected'],
  rejected: ['retest'],
  uncertain: ['confirmed', 'rejected', 'retest'],
  retest: ['awaiting_human', 'confirmed', 'rejected'],
};

/** 对外 → 内部（Agent 写入时用；Agent 的判定一律落 auto_verified，人工签字位不丢） */
const EXTERNAL_TO_INTERNAL_VERDICT = {
  confirmed: { state: 'auto_verified', verdict: 'confirmed' },
  rejected: { state: 'auto_verified', verdict: 'false_positive' },
  inconclusive: { state: 'auto_verified', verdict: 'uncertain' },
  suspected: { state: 'retest', verdict: 'need_retest' },
};

/** 内部 verdict → 对外状态（auto_verified 对外收敛成 Agent 自己给的结论） */
const VERDICT_TO_EXTERNAL = {
  confirmed: 'confirmed',
  false_positive: 'rejected',
  uncertain: 'inconclusive',
  need_retest: 'suspected',
};

/** 契约层认定的「对 Agent 可见」字段：只有这些变了才推进实体版本 rev（租约/心跳推不动，避免无谓 412） */
const CONTENT_FIELDS = ['state', 'verdict', 'verdict_note', 'confidence', 'evidence', 'evidence_ids',
  'raw_request', 'raw_response', 'curl', 'parameter', 'endpoint', 'endpoint_norm', 'location',
  'severity', 'reproduction_steps', 'scope', 'target', 'title', 'rule_id', 'url', 'tier',
  'supersedes', 'superseded_by', 'reopened_reason'];

const AGENT_SCOPES = ['ingest', 'review'];

/** 默认限流：每个 worker 每分钟的请求数 */
function rateLimitPerMinute() {
  try {
    const v = parseInt(String($os.getenv('RECONLAB_RATE_LIMIT') || ''), 10);
    if (!isNaN(v) && v > 0) return v;
  } catch (e) { /* ignore */ }
  return 60;
}

/* ───────────────────────── 错误与响应 ───────────────────────── */

function ContractError(status, code, message, data) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  e.data = data || {};
  e.isContractError = true;
  return e;
}

function fail(status, code, message, data) {
  return ContractError(status, code, message, data);
}

/** 统一响应封装：所有契约响应都带 contract_version */
function ok(c, payload, status) {
  const body = { contract_version: CONTRACT_VERSION };
  for (const k in payload) { if (Object.prototype.hasOwnProperty.call(payload, k)) body[k] = payload[k]; }
  try { c.response.header().set('X-Contract-Version', String(CONTRACT_VERSION)); } catch (e) { /* ignore */ }
  return c.json(status || 200, body);
}

function sendError(c, err) {
  const status = (err && err.status) || 500;
  const code = (err && err.code) || 'INTERNAL';
  const message = (err && err.message) || '服务器内部错误';
  const data = (err && err.data) || {};
  const payload = {
    contract_version: CONTRACT_VERSION,
    status: status,
    code: code,
    message: String(message),
    data: data,
  };
  try { c.response.header().set('X-Contract-Version', String(CONTRACT_VERSION)); } catch (e) { /* ignore */ }
  if (status === 429 && data.retry_after) {
    try { c.response.header().set('Retry-After', String(data.retry_after)); } catch (e) { /* ignore */ }
  }
  if (data.current_etag !== undefined) {
    try { c.response.header().set('ETag', String(data.current_etag)); } catch (e) { /* ignore */ }
  }
  return c.json(status, payload);
}

/** handler 外壳：把抛出的 ContractError 转成规范错误体，未预期的异常转 500 并留痕 */
function guard(c, fn) {
  try {
    return fn();
  } catch (err) {
    if (err && err.isContractError) return sendError(c, err);
    try {
      audit('contract', 'handler_error', {
        detail: String((err && err.stack) || err).slice(0, 800),
        status: 500,
      });
    } catch (e) { /* ignore */ }
    return sendError(c, fail(500, 'INTERNAL', '服务器内部错误'));
  }
}

/* ───────────────────────── 请求解析 ───────────────────────── */

/** 已知的头名字：multipart 请求里 requestInfo 可能整条解析失败，得能单独取值 */
const KNOWN_HEADERS = ['authorization', 'idempotency-key', 'if-match', 'if-none-match', 'lease-token',
  'content-digest', 'x-content-sha256', 'x-contract-version', 'content-type', 'user-agent',
  'x-agent-name', 'accept'];

function headersFromRaw(c) {
  const out = {};
  const req = c.request;
  if (!req) return out;
  for (let i = 0; i < KNOWN_HEADERS.length; i++) {
    const name = KNOWN_HEADERS[i];
    try {
      const v = req.header.get(name);
      if (v !== undefined && v !== null && String(v) !== '') {
        out[name.replace(/-/g, '_')] = String(v);
      }
    } catch (e) { /* ignore */ }
  }
  return out;
}

function reqInfo(c) {
  let out = { query: {}, headers: {}, body: {}, method: '', auth: null };
  try {
    const info = c.requestInfo();
    out.query = info.query || {};
    out.headers = info.headers || {};
    out.body = info.body || {};
    out.method = String(info.method || '');
    out.auth = info.auth || null;
  } catch (e) {
    out.parseError = String(e);
  }
  const raw = headersFromRaw(c);
  for (const k in raw) {
    if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
    if (!out.headers[k]) out.headers[k] = raw[k];   // requestInfo 已给的不覆盖
  }
  return out;
}

function header(info, name) {
  const key = String(name).toLowerCase().replace(/-/g, '_');
  const v = info.headers[key];
  return v === undefined || v === null ? '' : String(v);
}

/** 契约版本协商：v1 走老的集合接口，新接口只认 2 */
function assertContractVersion(info) {
  const raw = header(info, 'x-contract-version');
  if (!raw) return;
  const v = parseInt(raw, 10);
  if (v === CONTRACT_VERSION) return;
  if (v === 1) {
    throw fail(400, 'CONTRACT_VERSION_UNSUPPORTED',
      '本接口是契约 v2；v1 请继续用原来的集合接口（/api/collections/review_queue/records），兼容期两者并存', {
      requested: raw, supported: [CONTRACT_VERSION],
    });
  }
  throw fail(400, 'CONTRACT_VERSION_UNSUPPORTED', '不支持的契约版本', {
    requested: raw, supported: [CONTRACT_VERSION],
  });
}

function bodyObject(c, info) {
  const b = info.body;
  if (!b || typeof b !== 'object') throw fail(400, 'INVALID_JSON', '请求体必须是 JSON 对象');
  return b;
}

function qInt(info, key, dflt, min, max) {
  const raw = info.query[key];
  if (raw === undefined || raw === null || raw === '') return dflt;
  const v = parseInt(String(raw), 10);
  if (isNaN(v)) throw fail(422, 'VALIDATION_FAILED', '参数 ' + key + ' 必须是整数', { field: key });
  if (min !== undefined && v < min) return min;
  if (max !== undefined && v > max) return max;
  return v;
}

function qStr(info, key) {
  const raw = info.query[key];
  if (raw === undefined || raw === null) return '';
  return String(raw).trim();
}

/* ───────────────────────── 时间 ───────────────────────── */

/** PocketBase 存的是 UTC 字符串，契约为保持可比性统一用带 Z 的 ISO8601 */
function isoOf(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)) {
    const t = s.replace(' ', 'T');
    return /Z$|[+-]\d{2}:?\d{2}$/.test(t) ? t : t + 'Z';
  }
  return s;
}

function nowDate() { return new Date(); }

function addSeconds(date, seconds) { return new Date(date.getTime() + seconds * 1000); }

/** 解析外部传入的 ISO8601（要求带时区，否则按 UTC+8 的常见误用拒掉） */
function parseInstant(text, field) {
  const s = String(text || '').trim();
  if (!s) throw fail(422, 'VALIDATION_FAILED', field + ' 不能为空', { field: field });
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    throw fail(422, 'VALIDATION_FAILED', field + ' 必须是带时区的 ISO8601（例：2026-10-07T19:00:00+08:00）', { field: field });
  }
  const d = new Date(s.replace(' ', 'T'));
  if (isNaN(d.getTime())) throw fail(422, 'VALIDATION_FAILED', field + ' 不是合法时间', { field: field });
  return d;
}

/* ───────────────────────── 编码 ───────────────────────── */

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function b64urlEncode(str) {
  let out = '';
  for (let i = 0; i < str.length; i += 3) {
    const c1 = str.charCodeAt(i);
    const c2 = i + 1 < str.length ? str.charCodeAt(i + 1) : NaN;
    const c3 = i + 2 < str.length ? str.charCodeAt(i + 2) : NaN;
    const n = (c1 << 16) | ((isNaN(c2) ? 0 : c2) << 8) | (isNaN(c3) ? 0 : c3);
    out += B64_ALPHABET[(n >> 18) & 63] + B64_ALPHABET[(n >> 12) & 63];
    out += isNaN(c2) ? '' : B64_ALPHABET[(n >> 6) & 63];
    out += isNaN(c3) ? '' : B64_ALPHABET[n & 63];
  }
  return out;
}

function b64urlDecode(str) {
  const s = String(str || '').replace(/=+$/, '');
  let bits = 0;
  let acc = 0;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const idx = B64_ALPHABET.indexOf(s[i]);
    if (idx < 0) continue;
    acc = (acc << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((acc >> bits) & 255);
    }
  }
  return out;
}

const HEX = '0123456789abcdef';

function bytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] & 255;
    out += HEX[(b >> 4) & 15] + HEX[b & 15];
  }
  return out;
}

function strToBytes(s) {
  const arr = [];
  for (let i = 0; i < s.length; i++) {
    let code = s.charCodeAt(i);
    if (code < 128) { arr.push(code); } else if (code < 2048) {
      arr.push(192 | (code >> 6), 128 | (code & 63));
    } else {
      arr.push(224 | (code >> 12), 128 | ((code >> 6) & 63), 128 | (code & 63));
    }
  }
  return arr;
}

function hexToBytes(hex) {
  const s = String(hex || '').replace(/[^0-9a-fA-F]/g, '');
  const out = [];
  for (let i = 0; i + 1 < s.length; i += 2) out.push(parseInt(s.substr(i, 2), 16));
  return out;
}

function bytesToStr(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i] & 255);
  return out;
}

/** base64 → 字节数组（容错 url-safe 与缺省 padding） */
function base64ToBytes(str) {
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '').replace(/\s+/g, '');
  const out = [];
  let bits = 0;
  let acc = 0;
  for (let i = 0; i < s.length; i++) {
    const idx = table.indexOf(s[i]);
    if (idx < 0) continue;
    acc = (acc << 6) | idx;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); }
  }
  return out;
}

/** 字节数组 → 标准 base64 */
function bytesToBase64(bytes) {
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let off = 0; off < bytes.length; off += 3) {
    const b1 = bytes[off] & 255;
    const has2 = off + 1 < bytes.length;
    const has3 = off + 2 < bytes.length;
    const b2 = has2 ? bytes[off + 1] & 255 : 0;
    const b3 = has3 ? bytes[off + 2] & 255 : 0;
    out += table[b1 >> 2];
    out += table[((b1 & 3) << 4) | (b2 >> 4)];
    out += has2 ? table[((b2 & 15) << 2) | (b3 >> 6)] : '=';
    out += has3 ? table[b3 & 63] : '=';
  }
  return out;
}

/**
 * 还原 PocketBase 的 json 字段。
 * 坑：在 JSVM 里读 json 字段拿到的是「原始 JSON 文本的字节数组」（[91,123,...]），
 * 不是 JS 数组/对象；不还原的话 assets / evidence_ids / 判定准则全读成空。
 */
function jsonValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;
    try { return JSON.parse(s); } catch (e) { return null; }
  }
  if (Object.prototype.toString.call(value) === '[object Array]') {
    if (value.length === 0) return null;
    let numeric = true;
    for (let i = 0; i < value.length; i++) {
      if (typeof value[i] !== 'number') { numeric = false; break; }
    }
    if (!numeric) return value;
    try { return JSON.parse(bytesToStr(value)); } catch (e) { return null; }
  }
  if (typeof value === 'object') return value;
  return null;
}

/** 一律拿到数组：字符串、字节数组、真数组都能吃 */
function asArray(value) {
  let v = jsonValue(value);
  if (typeof v === 'string') v = jsonValue(v);
  return Object.prototype.toString.call(v) === '[object Array]' ? v : [];
}

function asObject(value) {
  let v = jsonValue(value);
  if (typeof v === 'string') v = jsonValue(v);
  return v && typeof v === 'object' && Object.prototype.toString.call(v) !== '[object Array]' ? v : null;
}

/** 纯 JS SHA-256（用于没法调系统 sha256sum 的环境，仅对中小文件启用） */
function sha256Bytes(bytes) {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  let H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const data = bytes.slice(0);
  const bitLen = data.length * 8;
  data.push(0x80);
  while (data.length % 64 !== 56) data.push(0);
  for (let i = 7; i >= 0; i--) data.push((bitLen / Math.pow(2, i * 8)) & 255);
  const w = new Array(64);
  for (let off = 0; off < data.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = ((data[off + i * 4] & 255) << 24) | ((data[off + i * 4 + 1] & 255) << 16) |
        ((data[off + i * 4 + 2] & 255) << 8) | (data[off + i * 4 + 3] & 255);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
      const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, cc, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ ((~e) & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const mj = (a & b) ^ (a & cc) ^ (b & cc);
      const t2 = (S0 + mj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = cc; cc = b; b = a; a = (t1 + t2) | 0;
    }
    H = [(H[0] + a) | 0, (H[1] + b) | 0, (H[2] + cc) | 0, (H[3] + d) | 0,
      (H[4] + e) | 0, (H[5] + f) | 0, (H[6] + g) | 0, (H[7] + h) | 0];
  }
  const out = [];
  for (let i = 0; i < 8; i++) {
    out.push((H[i] >>> 24) & 255, (H[i] >>> 16) & 255, (H[i] >>> 8) & 255, H[i] & 255);
  }
  return bytesToHex(out);
}

/** 解析 RFC 9530 的 Content-Digest：sha-256=:BASE64: */
function parseContentDigest(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const m = /sha-256\s*=\s*:([A-Za-z0-9+/=_-]+):/i.exec(s);
  if (!m) return null;
  return bytesToHex(base64ToBytes(m[1]));
}

/* ───────────────────────── 分页游标 ───────────────────────── */

function encodeCursor(obj) { return b64urlEncode(JSON.stringify(obj)); }

function decodeCursor(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(b64urlDecode(String(raw)));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (e) {
    throw fail(422, 'VALIDATION_FAILED', 'cursor 不合法（不要自己拼游标，用响应里的 next_cursor）', { field: 'cursor' });
  }
}

/* ───────────────────────── 审计留痕 ───────────────────────── */

function audit(event, action, detail) {
  try {
    const col = $app.findCollectionByNameOrId('contract_audit');
    if (!col) return;
    const rec = new Record(col);
    rec.set('event', String(event || ''));
    rec.set('action', String(action || ''));
    rec.set('status', detail && detail.status !== undefined ? detail.status : 0);
    rec.set('agent_name', String((detail && detail.agent_name) || ''));
    rec.set('item_id', String((detail && detail.item_id) || ''));
    rec.set('scope_id', String((detail && detail.scope_id) || ''));
    rec.set('code', String((detail && detail.code) || ''));
    rec.set('detail', String((detail && detail.detail) || '').slice(0, 2000));
    $app.save(rec);
  } catch (e) { /* 审计失败不影响主流程 */ }
}

module.exports = {
  CONTRACT_VERSION: CONTRACT_VERSION,
  EXTERNAL_STATES: EXTERNAL_STATES,
  INTERNAL_STATES: INTERNAL_STATES,
  TRANSITIONS: TRANSITIONS,
  EXTERNAL_TO_INTERNAL_VERDICT: EXTERNAL_TO_INTERNAL_VERDICT,
  VERDICT_TO_EXTERNAL: VERDICT_TO_EXTERNAL,
  CONTENT_FIELDS: CONTENT_FIELDS,
  AGENT_SCOPES: AGENT_SCOPES,
  rateLimitPerMinute: rateLimitPerMinute,
  fail: fail,
  ok: ok,
  sendError: sendError,
  guard: guard,
  reqInfo: reqInfo,
  header: header,
  assertContractVersion: assertContractVersion,
  bodyObject: bodyObject,
  qInt: qInt,
  qStr: qStr,
  isoOf: isoOf,
  nowDate: nowDate,
  addSeconds: addSeconds,
  parseInstant: parseInstant,
  b64urlEncode: b64urlEncode,
  b64urlDecode: b64urlDecode,
  bytesToHex: bytesToHex,
  bytesToStr: bytesToStr,
  jsonValue: jsonValue,
  asArray: asArray,
  asObject: asObject,
  base64ToBytes: base64ToBytes,
  bytesToBase64: bytesToBase64,
  hexToBytes: hexToBytes,
  strToBytes: strToBytes,
  sha256Bytes: sha256Bytes,
  parseContentDigest: parseContentDigest,
  encodeCursor: encodeCursor,
  decodeCursor: decodeCursor,
  audit: audit,
};
