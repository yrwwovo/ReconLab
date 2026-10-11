/**
 * ReconLab 契约层 · 授权范围（scope）模型
 *
 * 设计要点（对应契约 v2 的硬要求）：
 *   1. scope_id 只是索引，不是授权凭证 —— 任何入参都要拿 target/endpoint 现算匹配，
 *      绝不因为 Agent 传了某个 id 就放行。
 *   2. 域名匹配必须是点边界：example.com 匹配 example.com / a.example.com，
 *      绝不匹配 notexample.com。
 *   3. URL 前缀匹配前先做规范化（解码百分号、折叠斜杠、拒绝对路径穿越）。
 *   4. 时效在 claim / heartbeat / 提交三个点都要校验，中途失效 = 任务作废。
 *   5. 重定向逐跳校验：agent 每一跳都要问服务端（POST /api/scope/check）。
 */

const K = require('./kit.js');

/* ───────────────────────── URL / 端点规范化 ───────────────────────── */

const DEFAULT_PORTS = { http: 80, https: 443, ws: 80, wss: 443 };

function decodePercent(s) {
  return String(s).replace(/%([0-9a-fA-F]{2})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodePercentDeep(s) {
  let cur = String(s);
  for (let i = 0; i < 3; i++) {
    const next = decodePercent(cur);
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

/**
 * 解析 URL 成结构化片段。不依赖 goja 里没有的 URL 类。
 * 返回 null 表示无法解析。
 */
function parseUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) {
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/.exec(s);
    if (!m) return null;
    const scheme = m[1].toLowerCase();
    const authority = m[2];
    const path = m[3] || '/';
    if (authority.indexOf('@') >= 0) return null; // 契约端点不许带凭据
    let host = authority;
    let port = '';
    if (host.charAt(0) === '[') {
      const idx = host.indexOf(']');
      if (idx < 0) return null;
      port = host.slice(idx + 1).replace(/^:/, '');
      host = host.slice(0, idx + 1);
    } else if (host.indexOf(':') >= 0) {
      const parts = host.split(':');
      port = parts.pop();
      host = parts.join(':');
    }
    return { scheme: scheme, host: host.toLowerCase(), port: port, path: path };
  }
  // 裸 host[:port][/path] —— 视为 https
  const m2 = /^([^/?#]+)([^?#]*)/.exec(s);
  if (!m2) return null;
  let host = m2[1];
  let port = '';
  if (host.indexOf(':') >= 0) {
    const parts = host.split(':');
    port = parts.pop();
    host = parts.join(':');
  }
  if (!/^[A-Za-z0-9._\-\[\]:]+$/.test(host)) return null;
  return { scheme: 'https', host: host.toLowerCase(), port: port, path: m2[2] || '/' };
}

function normalizePath(path) {
  let p = decodePercentDeep(path || '/');
  if (p.indexOf('\\') >= 0) return null;              // 反斜杠一律当穿越姿势
  if (/[\x00-\x1f]/.test(p)) return null;
  p = p.replace(/\/{2,}/g, '/');
  if (!p.startsWith('/')) p = '/' + p;
  const segs = p.split('/');
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '.' || seg === '') { if (i === 0) out.push(''); continue; }
    if (seg === '..') return null;                    // 出现穿越直接判定为不可信端点
    out.push(seg);
  }
  let joined = out.join('/');
  if (joined === '') joined = '/';
  if (joined.length > 1 && joined.slice(-1) === '/') joined = joined.slice(0, -1);
  return joined || '/';
}

/**
 * 端点规范化：丢掉 query / fragment / 凭据，统一大小写与默认端口，折叠路径。
 * 契约里所有「端点」字段都以这个结果为准（服务端算，客户端传来的只作参考）。
 */
function normalizeEndpoint(raw) {
  const u = parseUrl(raw);
  if (!u) return null;
  const path = normalizePath(u.path);
  if (path === null) return null;
  let hostport = u.host;
  const dp = DEFAULT_PORTS[u.scheme];
  if (u.port && String(dp) !== String(u.port)) hostport = u.host + ':' + u.port;
  return u.scheme + '://' + hostport + path;
}

/** 取 host（去掉端口/IPv6 方括号） */
function hostOf(raw) {
  const u = parseUrl(raw);
  if (!u) return '';
  return u.host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase().replace(/\.$/, '');
}

/* ───────────────────────── 资产匹配 ───────────────────────── */

function isIpv4(s) { return /^\d{1,3}(\.\d{1,3}){3}$/.test(String(s)); }

function ipv4ToInt(s) {
  const parts = String(s).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (let i = 0; i < 4; i++) {
    const v = parseInt(parts[i], 10);
    if (isNaN(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function isIpv6(s) { return String(s).indexOf(':') >= 0 && /^[0-9a-fA-F:]+$/.test(String(s)); }

function normAssetValue(type, value) {
  const v = String(value || '').trim().toLowerCase();
  if (type === 'domain') return v.replace(/^\*\./, '').replace(/^\./, '').replace(/\.$/, '');
  return v;
}

/** 域名点边界匹配 */
function domainMatches(host, domain) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  const d = normAssetValue('domain', domain);
  if (!h || !d) return false;
  return h === d || h.slice(-(d.length + 1)) === '.' + d;
}

/** CIDR / 精确 IP 匹配 */
function ipMatches(cidr, ip) {
  const c = String(cidr || '').trim().toLowerCase();
  const a = String(ip || '').trim().toLowerCase();
  if (!c || !a) return false;
  if (c.indexOf('/') < 0) return c === a;
  const parts = c.split('/');
  const base = parts[0];
  const bits = parseInt(parts[1], 10);
  if (isIpv4(base) && isIpv4(a)) {
    const bn = ipv4ToInt(base);
    const an = ipv4ToInt(a);
    if (bn === null || an === null || isNaN(bits) || bits < 0 || bits > 32) return false;
    if (bits === 0) return true;
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return ((bn & mask) >>> 0) === ((an & mask) >>> 0);
  }
  if (isIpv6(base) && isIpv6(a) && bits === 128) return base === a;
  return false;
}

/** URL 前缀匹配：规范化后必须是段边界前缀 */
function urlPrefixMatches(prefix, url) {
  const p = normalizeEndpoint(prefix);
  const target = normalizeEndpoint(url) || url;
  if (!p || !target) return false;
  if (target === p) return true;
  return target.indexOf(p + '/') === 0;
}

/**
 * 单条资产是否覆盖某个主机 / URL。
 * kind: domain | ip_cidr | url_prefix（ip 作为 ip_cidr 的别名）
 */
function assetCovers(asset, ctx) {
  const type = String((asset && asset.type) || '').toLowerCase();
  const value = String((asset && asset.value) || '');
  if (!value) return false;
  if (type === 'domain') {
    if (ctx.host && domainMatches(ctx.host, value)) return true;
    // 目标值不是域名时（比如 target 就叫 demo.test），也允许按裸串比一次
    return false;
  }
  if (type === 'ip_cidr' || type === 'ip') {
    if (ctx.ip && ipMatches(value, ctx.ip)) return true;
    if (ctx.host && (isIpv4(ctx.host) || isIpv6(ctx.host)) && ipMatches(value, ctx.host)) return true;
    return false;
  }
  if (type === 'url_prefix') {
    if (ctx.url && urlPrefixMatches(value, ctx.url)) return true;
    return false;
  }
  return false;
}

/* ───────────────────────── scope 解析与求值 ───────────────────────── */

function parseAssets(record) {
  return K.asArray(record.get('assets'));
}

function isActiveScope(scope, at) {
  const status = String(scope.get('status') || '');
  if (status !== 'active') return false;
  const now = at || new Date();
  const from = scope.get('authorized_at');
  const until = scope.get('expires_at');
  if (from) {
    const f = new Date(String(from).replace(' ', 'T'));
    if (!isNaN(f.getTime()) && f.getTime() > now.getTime()) return false;
  }
  if (until) {
    const u = new Date(String(until).replace(' ', 'T'));
    if (!isNaN(u.getTime()) && u.getTime() <= now.getTime()) return false;
  }
  return true;
}

function scopeToJson(scope) {
  const assets = parseAssets(scope);
  return {
    id: scope.id,
    name: String(scope.get('name') || ''),
    assets: assets.map((a) => ({ type: String((a && a.type) || ''), value: String((a && a.value) || '') })),
    status: String(scope.get('status') || ''),
    authorized_at: K.isoOf(scope.get('authorized_at')),
    expires_at: K.isoOf(scope.get('expires_at')),
    authorization_reference: String(scope.get('authorization_reference') || ''),
    note: String(scope.get('note') || ''),
    active: isActiveScope(scope),
    created: K.isoOf(scope.get('created')),
    updated: K.isoOf(scope.get('updated')),
  };
}

function allScopes() {
  try {
    return $app.findRecordsByFilter('scopes', '1=1', 'created', 500, 0);
  } catch (e) {
    return [];
  }
}

/**
 * 现算匹配：给定 target / endpoint / url，找出覆盖它的 active scope。
 * 返回 {in_scope, scope, asset, reason}
 */
function resolve(input, opts) {
  const options = opts || {};
  const endpoint = String(input.endpoint || input.url || '').trim();
  const target = String(input.target || '').trim();
  const scopeId = String(input.scope_id || input.scopeId || '').trim();
  const at = options.at || new Date();

  const host = hostOf(endpoint) || hostOf(target);
  const url = endpoint || target;
  const ctx = { host: host, url: url, ip: host };

  const scopes = allScopes();
  let restricted = scopes;
  if (scopeId) {
    restricted = scopes.filter((s) => s.id === scopeId);
    if (!restricted.length) {
      return { in_scope: false, reason: 'scope_not_found', scope_id: scopeId, host: host };
    }
  }

  // 先找 active 且覆盖 endpoint 的
  for (let i = 0; i < restricted.length; i++) {
    const scope = restricted[i];
    if (!isActiveScope(scope, at)) {
      const covered = parseAssets(scope).some((a) => assetCovers(a, ctx));
      if (covered) {
        return { in_scope: false, reason: 'scope_inactive', scope: scope, scope_id: scope.id, host: host };
      }
      continue;
    }
    const assets = parseAssets(scope);
    for (let j = 0; j < assets.length; j++) {
      if (assetCovers(assets[j], ctx)) {
        // target 看起来像主机/URL 时，也要落在同一 scope 内
        if (target && (target.indexOf('.') >= 0 || target.indexOf('/') >= 0)) {
          const targetCtx = { host: hostOf(target), url: target, ip: hostOf(target) };
          const ok = assets.some((a) => assetCovers(a, targetCtx));
          if (!ok) {
            return { in_scope: false, reason: 'target_out_of_scope', scope: scope, scope_id: scope.id, host: host };
          }
        }
        return { in_scope: true, scope: scope, scope_id: scope.id, asset: assets[j], host: host };
      }
    }
  }
  return { in_scope: false, reason: 'no_matching_asset', host: host };
}

/** 校验通过则返回 scope 记录，否则抛 403 */
function requireInScope(input, opts) {
  const res = resolve(input, opts);
  if (!res.in_scope) {
    throw K.fail(403, 'OUT_OF_SCOPE',
      '目标不在任何 active 授权范围内（scope_id 只是索引，服务端按 target/endpoint 现算）', {
      reason: res.reason,
      host: res.host || '',
      scope_id: res.scope_id || '',
      endpoint: String((input && input.endpoint) || (input && input.url) || ''),
    });
  }
  return res;
}

module.exports = {
  parseUrl: parseUrl,
  normalizePath: normalizePath,
  normalizeEndpoint: normalizeEndpoint,
  hostOf: hostOf,
  domainMatches: domainMatches,
  ipMatches: ipMatches,
  urlPrefixMatches: urlPrefixMatches,
  assetCovers: assetCovers,
  parseAssets: parseAssets,
  isActiveScope: isActiveScope,
  scopeToJson: scopeToJson,
  allScopes: allScopes,
  resolve: resolve,
  requireInScope: requireInScope,
};
