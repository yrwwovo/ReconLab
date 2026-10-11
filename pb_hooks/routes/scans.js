/**
 * ReconLab 契约层 · 扫描工具后端三接口（PhantomVeil 把 ReconLab 当扫描后端调用）
 *
 *   POST /api/scans               下单扫描（必须带 Idempotency-Key，重复返回同一 scan）
 *   GET  /api/scans/{id}          查状态/进度（state + progress + stats，异步态）
 *   GET  /api/scans/{id}/findings 拉结果（running 时 complete=false，返回 partial）
 *
 * 约定（与 contract-v2 对称）：
 *   - 鉴权走 rlk_ Bearer key，scope = 'scan'（最小权限，和 ingest/review 分开）。
 *   - scope 校验结果(scope_check)与预算余量(budget)作为响应字段带回，服务端说了算。
 *   - 错误一律走稳定 code（客户端断言 code，不 match message）。
 *   - 幂等键由客户端生成(稳定 UUID)，服务端只认 Idempotency-Key 头，不自造、不退回内容 hash。
 *
 * JSVM 坑：handler 不共享顶层作用域；本模块内 require 用相对路径 '../lib/...'。
 */

const K = require('../lib/kit.js');
const A = require('../lib/auth.js');
const SC = require('../lib/scope.js');
const IDEM = require('../lib/idem.js');
const RATE = require('../lib/rate.js');

const SCAN_KINDS = ['subdomain', 'port', 'http', 'dir', 'vuln', 'poc'];
const CONTRACT_STATES = ['queued', 'running', 'done', 'failed'];
const DEFAULT_SCAN_BUDGET = 100;
const FINDINGS_MAX = 500;

/* ───────────────────────── 预算（按 scope_id 计量） ───────────────────────── */

function scanBudgetLimit() {
  try {
    const v = parseInt(String($os.getenv('RECONLAB_SCAN_BUDGET') || ''), 10);
    if (!isNaN(v) && v > 0) return v;
  } catch (e) { /* ignore */ }
  return DEFAULT_SCAN_BUDGET;
}

/** 幂等去重窗口：只兜崩溃重试，默认 2h，RECONLAB_SCAN_IDEM_TTL(秒) 可覆盖。 */
function scanIdemTtl() {
  try {
    const v = parseInt(String($os.getenv('RECONLAB_SCAN_IDEM_TTL') || ''), 10);
    if (!isNaN(v) && v > 0) return v;
  } catch (e) { /* ignore */ }
  return 7200;
}

/** remaining = limit - 该 scope 下非 failed/canceled 的 scan 数（createScan 扣 1 即落一条 queued）。 */
function budgetFor(scopeId) {
  const limit = scanBudgetLimit();
  let used = 0;
  if (scopeId) {
    try {
      // 计量规则：queued/running/done 计入消费；canceled 一律退；failed 若从未真正排队运行
      // (started 为空，如 worker 没起来这类瞬时故障)也退，避免白烧预算；已 started 过的 failed 视为已消费、不退。
      const recs = $app.findRecordsByFilter('scans', 'scope_id = {:s}', '', 1000, 0, { s: scopeId });
      for (let i = 0; i < recs.length; i++) {
        const st = String(recs[i].get('status') || '');
        if (st === 'canceled') continue;
        if (st === 'failed' && !String(recs[i].get('started') || '')) continue;
        used += 1;
      }
    } catch (e) { used = 0; }
  }
  return { remaining: Math.max(0, limit - used), limit: limit };
}

/* ───────────────────────── scope 现算校验 ───────────────────────── */

function scopeCheckFor(target, scopeId) {
  const res = SC.resolve({ target: target, scope_id: scopeId });
  if (res.in_scope) {
    return { allowed: true, scope_id: String(res.scope_id || scopeId || '') };
  }
  const code = res.reason === 'scope_inactive' ? 'SCOPE_EXPIRED' : 'OUT_OF_SCOPE';
  return {
    allowed: false,
    scope_id: String(res.scope_id || scopeId || ''),
    code: code,
    reason: String(res.reason || ''),
  };
}

/* ───────────────────────── 状态映射 + 序列化 ───────────────────────── */

function contractState(raw) {
  const s = String(raw || 'queued');
  if (s === 'canceled') return 'failed';
  return CONTRACT_STATES.indexOf(s) >= 0 ? s : 'queued';
}

function resolveTargetValue(rel) {
  const id = typeof rel === 'string' ? rel : String((rel && rel.id) || '');
  if (!id) return '';
  try {
    const rec = $app.findRecordById('targets', id);
    return rec ? String(rec.get('value') || id) : id;
  } catch (e) { return id; }
}

function scanTargetString(record) {
  // 优先用下单时持久化的原始 target 字符串；老数据回退到 target 关系解析。
  const stored = String(record.get('target_value') || '');
  if (stored) return stored;
  return resolveTargetValue(record.get('target'));
}

function scanHandle(record) {
  const target = scanTargetString(record);
  const scopeId = String(record.get('scope_id') || '');
  return {
    id: record.id,
    state: contractState(record.get('status')),
    scope_check: scopeCheckFor(target, scopeId),
    budget: budgetFor(scopeId),
  };
}

function scanStatus(record) {
  const state = contractState(record.get('status'));
  const target = scanTargetString(record);
  const scopeId = String(record.get('scope_id') || '');
  const out = {
    id: record.id,
    state: state,
    progress: Number(record.get('progress') || 0),
    stats: K.asObject(record.get('stats')) || {},
    scope_check: scopeCheckFor(target, scopeId),
    budget: budgetFor(scopeId),
  };
  const message = String(record.get('message') || '');
  if (message) out.message = message;
  if (state === 'failed') {
    out.failure_code = String(record.get('failure_code') || 'SCAN_FAILED');
  }
  return out;
}

function findingJson(record) {
  const out = {
    id: record.id,
    title: String(record.get('title') || ''),
    severity: String(record.get('severity') || ''),
  };
  const url = String(record.get('url') || '');
  if (url) out.url = url;
  const service = String(record.get('service') || '');
  if (service) out.service = service;
  const version = String(record.get('version') || '');
  if (version) out.version = version;
  const fingerprint = String(record.get('fingerprint') || '');
  if (fingerprint) out.fingerprint = fingerprint;

  let cves = K.asArray(record.get('cve_candidates'));
  if (!cves.length) {
    const single = String(record.get('cve') || '');
    if (single) cves = [single];
  }
  if (cves.length) out.cve_candidates = cves;

  const evrefs = K.asArray(record.get('evidence_refs'));
  if (evrefs.length) out.evidence_refs = evrefs;

  const category = String(record.get('category') || '');
  if (category) out.category = category;
  const parameter = String(record.get('parameter') || '');
  if (parameter) out.parameter = parameter;
  const conf = record.get('confidence');
  if (conf !== null && conf !== undefined && String(conf) !== '') {
    out.confidence = Number(conf || 0);
  }
  return out;
}

/* ───────────────────────── POST /api/scans ───────────────────────── */

function resolveTargetRef(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (/^[a-z0-9]{15}$/.test(v)) return v;
  try {
    const rec = $app.findFirstRecordByFilter('targets', 'value = {:v} || name = {:v}', { v: v });
    return rec ? rec.id : '';
  } catch (e) { return ''; }
}

function create(c) {
  return K.guard(c, () => {
    const info = K.reqInfo(c);
    K.assertContractVersion(info);
    const agent = A.requireAgent(info, 'scan');
    const rate = RATE.check(agent);
    const body = K.bodyObject(c, info);

    const kind = String(body.kind || '').trim();
    const target = String(body.target || '').trim();
    const scopeId = String(body.scope_id || '').trim();

    if (SCAN_KINDS.indexOf(kind) < 0) {
      throw K.fail(422, 'VALIDATION_FAILED', 'kind 必须是 ' + SCAN_KINDS.join(' / '), { field: 'kind', got: kind });
    }
    if (!target) throw K.fail(422, 'VALIDATION_FAILED', 'target 不能为空', { field: 'target' });
    if (!scopeId) throw K.fail(422, 'VALIDATION_FAILED', 'scope_id 不能为空', { field: 'scope_id' });

    // 幂等：比对口径与客户端 key 对齐——只认 [kind, target, scope_id, args] 四元组，
    // args 缺省/null 归一为 {}，忽略 body 其它字段与键顺序，避免合法重试被误判 409。
    const idemArgs = (body.args === undefined || body.args === null) ? {} : body.args;
    const idemPayload = { kind: kind, target: target, scope_id: scopeId, args: idemArgs };
    const idem = IDEM.begin(info, agent, '/api/scans', idemPayload, true);
    if (idem && idem.replay) {
      return K.ok(c, idem.body, idem.status || 201);
    }

    // scope 现算校验：越界/失效一律拒，不建 scan（失败不落幂等，允许修好后用同 key 重试）
    const scopeCheck = scopeCheckFor(target, scopeId);
    if (!scopeCheck.allowed) {
      const status = scopeCheck.code === 'SCOPE_EXPIRED' ? 409 : 403;
      throw K.fail(status, scopeCheck.code,
        '目标不在有效授权范围内（服务端按 target 现算，scope_id 只是索引）', {
        scope_check: scopeCheck, budget: budgetFor(scopeId),
      });
    }

    // 预算：按 scope_id 计量，耗尽即拒
    const budget = budgetFor(scopeId);
    if (budget.remaining <= 0) {
      throw K.fail(429, 'BUDGET_EXHAUSTED',
        'scope ' + scopeId + ' 的扫描预算已耗尽（limit ' + budget.limit + '）', {
        scope_check: scopeCheck, budget: budget,
      });
    }

    let record = null;
    try {
      const col = $app.findCollectionByNameOrId('scans');
      record = new Record(col);
      record.set('name', (kind + ':' + target).slice(0, 240));
      record.set('kind', kind);
      const tref = resolveTargetRef(target);
      if (tref) record.set('target', tref);
      record.set('scope_id', scopeId);
      record.set('target_value', target);
      record.set('status', 'queued');
      record.set('progress', 0);
      if (body.args !== undefined) record.set('args', String(JSON.stringify(body.args)).slice(0, 4000));
      if (idem && idem.key) record.set('idem_key', idem.key);
      $app.save(record);
    } catch (err) {
      throw K.fail(500, 'SAVE_FAILED', '下单失败', { detail: String(err).slice(0, 300) });
    }

    const handle = scanHandle(record);
    if (idem && idem.key) {
      IDEM.finish(agent.id, '/api/scans', idem.key, idem.hash, 201, handle, scanIdemTtl());
    }
    K.audit('scans', 'create', {
      agent_name: agent.name, item_id: record.id, status: 201, scope_id: scopeId, code: kind,
    });

    const payload = {};
    for (const k in handle) { if (Object.prototype.hasOwnProperty.call(handle, k)) payload[k] = handle[k]; }
    payload.rate_limit = rate;
    return K.ok(c, payload, 201);
  });
}

/* ───────────────────────── GET /api/scans/{id} ───────────────────────── */

function loadScan(c) {
  const id = String(c.request.pathValue('id') || '');
  let record = null;
  try { record = $app.findRecordById('scans', id); } catch (e) { record = null; }
  if (!record) throw K.fail(404, 'NOT_FOUND', 'scan 不存在', { id: id });
  return record;
}

function getOne(c) {
  return K.guard(c, () => {
    const info = K.reqInfo(c);
    K.assertContractVersion(info);
    const agent = A.requireAgent(info, 'scan');
    const rate = RATE.check(agent);
    const record = loadScan(c);
    const body = scanStatus(record);
    body.rate_limit = rate;
    return K.ok(c, body);
  });
}

/* ───────────────────────── GET /api/scans/{id}/findings ───────────────────────── */

function findings(c) {
  return K.guard(c, () => {
    const info = K.reqInfo(c);
    K.assertContractVersion(info);
    const agent = A.requireAgent(info, 'scan');
    const rate = RATE.check(agent);
    const record = loadScan(c);
    const state = contractState(record.get('status'));

    let recs = [];
    try {
      recs = $app.findRecordsByFilter('findings', 'scan = {:s}', '-created', FINDINGS_MAX, 0, { s: record.id });
    } catch (e) { recs = []; }
    const items = [];
    for (let i = 0; i < recs.length; i++) items.push(findingJson(recs[i]));

    return K.ok(c, {
      id: record.id,
      state: state,
      complete: state === 'done',
      count: items.length,
      findings: items,
      rate_limit: rate,
    });
  });
}

module.exports = {
  create: create,
  getOne: getOne,
  findings: findings,
  budgetFor: budgetFor,
  scopeCheckFor: scopeCheckFor,
  contractState: contractState,
};
