/**
 * ReconLab 契约层 · 验证队列三条接口 + 领取 / 心跳 / 释放
 *
 *   GET    /api/verification/queue              拉待验证队列（语义化 REST，不让 Agent 碰底层表）
 *   GET    /api/verification/queue/{id}         单条详情（只读，拿最新 etag 用；不推 rev）
 *   POST   /api/verification/queue              上报新发现（必须带 Idempotency-Key）
 *   PATCH  /api/verification/queue/{id}         回写判定（必须带 If-Match，乐观锁）
 *   POST   /api/verification/queue/{id}/claim   显式领取（lease）
 *   POST   /api/verification/queue/{id}/heartbeat 续租
 *   POST   /api/verification/queue/{id}/release   主动释放
 *
 * 三条硬规矩：
 *   1. 写入前一律现算 scope（scope_id 只是索引，不是凭证），过期/越界直接拒。
 *   2. 回写必须持有效租约；租约被回收后旧 token 立刻作废（409 LEASE_EXPIRED）。
 *   3. 终态（confirmed/rejected 人工签字过）不能原地回退，要重开必须走 supersedes。
 */

const K = require('../lib/kit.js');
const A = require('../lib/auth.js');
const S = require('../lib/state.js');
const SER = require('../lib/serialize.js');
const SC = require('../lib/scope.js');
const RUB = require('../lib/rubric.js');
const IDEM = require('../lib/idem.js');
const RATE = require('../lib/rate.js');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_LEASE_SECONDS = 900;
const MAX_LEASE_SECONDS = 3600;
const SQL_PAGE = 200;
const MAX_SQL_PAGES = 5;

/* ───────────────────────── 公共小工具 ───────────────────────── */

function evalScopeExpr(states) {
  return 'state = "' + states.join('" || state = "') + '"';
}

function coarseFilterForExternal(state) {
  switch (state) {
    case 'suspected': return ['new', 'normalized', 'retest', 'auto_verified'];
    case 'testing': return ['awaiting_human', 'new', 'normalized', 'retest'];
    case 'confirmed': return ['confirmed', 'auto_verified'];
    case 'rejected': return ['rejected', 'auto_verified'];
    case 'inconclusive': return ['uncertain', 'auto_verified'];
    default: return null;
  }
}

function clearLease(record) {
  record.set('lease_token', '');
  record.set('lease_expires_at', '');
}

/** 惰性回收：读到过期租约就地清掉（清租约不改内部状态，对外自然退回 suspected） */
function reclaimIfExpired(record, at) {
  const token = record.get('lease_token');
  if (!token) return false;
  if (S.leaseActive(record, at)) return false;
  clearLease(record);
  try { $app.save(record); } catch (e) { /* ignore */ }
  return true;
}

function resolveTargetFilter(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  if (/^[a-z0-9]{15}$/.test(v)) return v;
  try {
    const rec = $app.findFirstRecordByFilter('targets', 'value = {:v} || name = {:v}', { v: v });
    return rec ? rec.id : '\u0000none';
  } catch (e) {
    return '\u0000none';
  }
}

function buildListFilter(info, externalState) {
  const parts = ['1=1'];
  const params = {};
  const kind = K.qStr(info, 'kind');
  const severity = K.qStr(info, 'severity');
  const target = K.qStr(info, 'target');
  const scopeId = K.qStr(info, 'scope_id');
  const since = K.qStr(info, 'since');

  if (externalState) {
    const coarse = coarseFilterForExternal(externalState);
    if (coarse) parts.push('(' + evalScopeExpr(coarse) + ')');
  }
  if (kind) { parts.push('rule_id = {:kind}'); params.kind = kind; }
  if (severity) { parts.push('severity = {:sev}'); params.sev = severity; }
  if (scopeId) { parts.push('scope = {:scope}'); params.scope = scopeId; }
  if (target) {
    const tid = resolveTargetFilter(target);
    if (tid === '\u0000none') parts.push('1=0');
    else { parts.push('target = {:target}'); params.target = tid; }
  }
  if (since) {
    try {
      parts.push('created >= {:since}');
      params.since = K.parseInstant(since, 'since').toISOString().replace('T', ' ');
    } catch (e) {
      throw K.fail(422, 'VALIDATION_FAILED', 'since 必须是带时区的 ISO8601', { field: 'since' });
    }
  }
  return { filter: parts.join(' && '), params: params };
}

function sortSpec(raw) {
  const s = String(raw || '').trim();
  switch (s) {
    case '-created': return { field: 'created', dir: 'desc', pbSort: '-created,-id' };
    case 'confidence': return { field: 'confidence', dir: 'asc', pbSort: 'confidence,created' };
    case '-confidence': return { field: 'confidence', dir: 'desc', pbSort: '-confidence,created' };
    case 'created':
    case '': return { field: 'created', dir: 'asc', pbSort: 'created,id' };
    default:
      throw K.fail(422, 'VALIDATION_FAILED',
        'sort 只支持 created / -created / confidence / -confidence', { field: 'sort', got: s });
  }
}

/* ───────────────────────── GET 拉队列 ───────────────────────── */

function list(c) {
  return K.guard(c, () => {
    const info = K.reqInfo(c);
    K.assertContractVersion(info);
    const agent = A.requireAgent(info, 'review');
    const rate = RATE.check(agent);

    const externalState = K.qStr(info, 'state');
    if (externalState && K.EXTERNAL_STATES.indexOf(externalState) < 0) {
      throw K.fail(422, 'INVALID_STATE',
        'state 只接受 ' + K.EXTERNAL_STATES.join(' / '), { got: externalState });
    }
    const limit = K.qInt(info, 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT);
    const sort = sortSpec(K.qStr(info, 'sort'));
    const cursor = K.decodeCursor(K.qStr(info, 'cursor'));
    const at = new Date();

    const built = buildListFilter(info, externalState);
    const parts = [built.filter];
    const params = {};
    for (const kk in built.params) { if (Object.prototype.hasOwnProperty.call(built.params, kk)) params[kk] = built.params[kk]; }

    if (cursor && cursor.mode === 'key' && sort.field === 'created') {
      if (sort.dir === 'asc') {
        parts.push('((created > {:ct}) || (created = {:ct} && id > {:ci}))');
      } else {
        parts.push('((created < {:ct}) || (created = {:ct} && id < {:ci}))');
      }
      params.ct = String(cursor.t || '');
      params.ci = String(cursor.i || '');
    }
    const offset = cursor && cursor.mode === 'offset' ? Number(cursor.p || 0) * limit : 0;

    const filter = parts.join(' && ');
    const cache = { targets: {}, evidence: {} };
    const items = [];
    let nextCursor = null;
    let sqlOffset = offset;
    let scanned = 0;

    for (let page = 0; page < MAX_SQL_PAGES; page++) {
      let recs = [];
      try {
        recs = $app.findRecordsByFilter('review_queue', filter, sort.pbSort, SQL_PAGE, sqlOffset, params);
      } catch (err) {
        throw K.fail(500, 'QUERY_FAILED', '队列查询失败', { detail: String(err).slice(0, 300) });
      }
      if (!recs.length) break;
      sqlOffset += recs.length;
      for (let i = 0; i < recs.length; i++) {
        const rec = recs[i];
        reclaimIfExpired(rec, at);
        scanned += 1;
        if (externalState && S.externalOf(rec, at) !== externalState) continue;
        items.push(SER.item(rec, { at: at, cache: cache }));
        if (items.length > limit) break;
      }
      if (items.length > limit) break;
      if (recs.length < SQL_PAGE) break;
    }

    let hasMore = false;
    if (items.length > limit) {
      items.pop();
      hasMore = true;
    }
    if (hasMore && items.length) {
      const last = items[items.length - 1];
      if (sort.field === 'created') {
        // 用库里的原始 created 值做游标，避免格式往返
        let rawCreated = '';
        try {
          const rec = $app.findRecordById('review_queue', last.id);
          rawCreated = String(rec.get('created'));
        } catch (e) { rawCreated = last.created || ''; }
        nextCursor = K.encodeCursor({ mode: 'key', t: rawCreated, i: last.id });
      } else {
        const pageIdx = Math.floor(offset / limit) + 1;
        nextCursor = K.encodeCursor({ mode: 'offset', p: pageIdx });
      }
    }

    return K.ok(c, {
      items: items,
      count: items.length,
      next_cursor: nextCursor,
      scanned: scanned,
      sort: sort.field === 'created' ? sort.dir === 'asc' ? 'created' : '-created'
        : sort.dir === 'asc' ? 'confidence' : '-confidence',
      rate_limit: rate,
      agent: { name: agent.name, scopes: agent.scopes },
    });
  });
}

/* ───────────────────────── GET 单条详情（只读） ───────────────────────── */

/**
 * 提交前对齐内容版本用的「干净读」。
 *
 * 只读语义（和 claim 严格分开，别拿 claim 当读接口用）：
 *   - 不要求持租约、不续租、不碰心跳、不改任何字段，因此也不会推进 rev / 换掉 etag
 *   - etag 与 PATCH 的 If-Match 同源（同一个 SER.etagOf），读到什么就拿什么去写
 *   - 已被新记录取代的记录照常返回（不像 claim / patch 那样 409），看 superseded_by 判断
 *   - 带 If-None-Match: <etag> 命中当前版本 → 304 空体，轮询预检省流量
 *
 * 注意：这里不做 scope 校验（读不产生后果，也不放行任何写）。写路径上的 scope 校验
 * 一个都没少 —— claim / heartbeat / patch 三个点照样各自现算。
 */
function getOne(c) {
  return K.guard(c, () => {
    const info = K.reqInfo(c);
    K.assertContractVersion(info);
    const agent = A.requireAgent(info, 'review');
    const rate = RATE.check(agent);

    const id = String(c.request.pathValue('id') || '');
    let record = null;
    try { record = $app.findRecordById('review_queue', id); } catch (e) { record = null; }
    if (!record) throw K.fail(404, 'NOT_FOUND', '记录不存在', { id: id });

    const at = new Date();
    const etag = SER.etagOf(record);

    let inm = '';
    try { inm = String(K.header(info, 'if-none-match') || '').trim().replace(/^W\//, ''); } catch (e) { inm = ''; }
    if (inm && inm === etag) {
      try { c.response.header().set('ETag', etag); } catch (e) { /* ignore */ }
      try { c.response.header().set('X-Contract-Version', String(K.CONTRACT_VERSION)); } catch (e) { /* ignore */ }
      return c.noContent(304);
    }

    try { c.response.header().set('ETag', etag); } catch (e) { /* ignore */ }

    return K.ok(c, {
      item: SER.item(record, { at: at, cache: { targets: {}, evidence: {} } }),
      rate_limit: rate,
    });
  });
}

/* ───────────────────────── POST 上报新发现 ───────────────────────── */

function readPayloadArray(body, field) {
  const v = body[field];
  if (v === undefined || v === null || v === '') return [];
  if (Object.prototype.toString.call(v) !== '[object Array]') {
    throw K.fail(422, 'VALIDATION_FAILED', field + ' 必须是数组', { field: field });
  }
  return v;
}

function validateEvidenceRefs(refs) {
  const out = [];
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    const id = typeof ref === 'string' ? ref : String((ref && ref.id) || '');
    if (!id) continue;
    let rec = null;
    try { rec = $app.findRecordById('evidence', id); } catch (e) { rec = null; }
    if (!rec) {
      throw K.fail(422, 'EVIDENCE_NOT_FOUND', '证据 ' + id + ' 不存在：先用 POST /api/evidence 上传拿 id', {
        evidence_id: id,
      });
    }
    const declared = typeof ref === 'object' ? String(ref.sha256 || '') : '';
    const stored = String(rec.get('sha256') || '');
    if (declared && stored && declared.toLowerCase() !== stored.toLowerCase()) {
      throw K.fail(422, 'EVIDENCE_HASH_MISMATCH', '证据 ' + id + ' 的 sha256 与上传时不一致', {
        evidence_id: id, declared: declared, stored: stored,
      });
    }
    out.push({ id: id, sha256: stored, kind: String(rec.get('kind') || ''), note: String(rec.get('note') || '') });
  }
  return out;
}

function create(c) {
  return K.guard(c, () => {
    const info = K.reqInfo(c);
    K.assertContractVersion(info);
    const agent = A.requireAgent(info, 'ingest');
    const rate = RATE.check(agent);
    const body = K.bodyObject(c, info);

    const idem = IDEM.begin(info, agent, 'POST /api/verification/queue', body, true);
    if (idem && idem.replay) {
      try { c.response.header().set('Idempotent-Replay', 'true'); } catch (e) { /* ignore */ }
      return c.json(idem.status, idem.body);
    }

    const kind = String(body.kind || '').trim();
    const endpointRaw = String(body.endpoint || body.url || '').trim();
    if (!kind) throw K.fail(422, 'VALIDATION_FAILED', 'kind 必填（对齐 PhantomVeil 插件 id）', { field: 'kind' });
    if (!endpointRaw) throw K.fail(422, 'VALIDATION_FAILED', 'endpoint 必填', { field: 'endpoint' });

    const endpointNorm = SC.normalizeEndpoint(endpointRaw);
    if (!endpointNorm) {
      throw K.fail(422, 'INVALID_ENDPOINT',
        'endpoint 无法规范化：必须是 http(s) URL，且不能带凭据或路径穿越', { endpoint: endpointRaw });
    }
    const targetValueRaw = String(body.target || '').trim();

    // 授权范围现算（不信任客户端传的 scope_id）
    const scopeRes = SC.requireInScope({
      endpoint: endpointRaw, target: targetValueRaw, scope_id: body.scope_id,
    });

    const extState = String(body.state || 'suspected').trim().toLowerCase();
    if (K.EXTERNAL_STATES.indexOf(extState) < 0) {
      throw K.fail(422, 'INVALID_STATE', 'state 只接受 ' + K.EXTERNAL_STATES.join(' / '), { got: extState });
    }
    const evidenceRefs = validateEvidenceRefs(readPayloadArray(body, 'evidence'));
    const steps = readPayloadArray(body, 'reproduction_steps');
    const checks = readPayloadArray(body, 'checks');
    const confidence = body.confidence === undefined ? 0 : Number(body.confidence);

    const rubric = RUB.checkVerdict(kind, extState, {
      reproduction_steps: steps, evidenceRefs: evidenceRefs, confidence: confidence,
      checks: checks, verdict_note: body.verdict_note, curl: body.curl, reason_code: body.reason_code,
    });
    if (rubric.errors.length) {
      throw K.fail(422, 'RUBRIC_VIOLATION', '不满足「' + kind + '」的判定准则：' + rubric.errors[0].message, {
        rubric: rubric.rubric, errors: rubric.errors, warnings: rubric.warnings,
      });
    }

    const dedupHash = [kind, endpointNorm, String(body.parameter || ''), String(body.location || '')].join('|');
    let existing = null;
    try {
      existing = $app.findFirstRecordByFilter('review_queue',
        'dedup_hash = {:h} && superseded_by = ""', { h: dedupHash });
    } catch (e) { existing = null; }

    if (existing && body.force_new !== true) {
      existing.set('instances', Number(existing.get('instances') || 0) + 1);
      const prev = Number(existing.get('confidence') || 0);
      if (confidence > prev) existing.set('confidence', confidence);
      $app.save(existing);
      K.audit('queue', 'ingest_dedup', {
        agent_name: agent.name, item_id: existing.id, status: 200, scope_id: scopeRes.scope_id,
      });
      const payload = {
        item: SER.item(existing, { cache: { targets: {}, evidence: {} } }),
        deduplicated: true,
        rubric_warnings: rubric.warnings,
        rate_limit: rate,
      };
      IDEM.finish(agent.id, 'POST /api/verification/queue', idem && idem.key, idem && idem.hash, 200, payload);
      return K.ok(c, payload, 200);
    }

    // 重开路径：新记录 supersedes 老记录，老的冻结，证据链不断
    let supersedes = null;
    if (body.supersedes) {
      const oldId = String(body.supersedes);
      try { supersedes = $app.findRecordById('review_queue', oldId); } catch (e) { supersedes = null; }
      if (!supersedes) throw K.fail(404, 'NOT_FOUND', 'supersedes 指向的记录不存在', { id: oldId });
    }

    const col = $app.findCollectionByNameOrId('review_queue');
    const rec = new Record(col);
    const mapped = S.internalForExternal(extState === 'suspected' ? 'suspected' : extState, body);
    rec.set('rule_id', kind);
    rec.set('title', String(body.title || kind));
    rec.set('url', endpointRaw);
    rec.set('endpoint', endpointRaw);
    rec.set('endpoint_norm', endpointNorm);
    rec.set('parameter', String(body.parameter || ''));
    rec.set('location', String(body.location || ''));
    rec.set('severity', String(body.severity || ''));
    rec.set('confidence', confidence);
    rec.set('origin', 'agent');
    rec.set('agent_name', agent.name);
    rec.set('dedup_hash', dedupHash);
    rec.set('instances', 1);
    rec.set('raw_request', String(body.raw_request || ''));
    rec.set('raw_response', String(body.raw_response || ''));
    rec.set('curl', String(body.curl || ''));
    rec.set('verdict_note', String(body.verdict_note || ''));
    rec.set('reproduction_steps', steps);
    rec.set('checks', JSON.stringify(checks));
    rec.set('evidence_ids', evidenceRefs.map((e) => e.id));
    rec.set('scope', scopeRes.scope_id);
    rec.set('rev', 1);
    rec.set('contract_note', 'ingested:scope=' + scopeRes.scope_id);
    if (targetValueRaw && /^[a-z0-9]{15}$/.test(targetValueRaw)) {
      try { rec.set('target', $app.findRecordById('targets', targetValueRaw).id); } catch (e) { /* ignore */ }
    }
    if (supersedes) {
      rec.set('supersedes', supersedes.id);
      rec.set('reopened_reason', String(body.reopened_reason || '重新验证'));
    }
    if (extState === 'suspected') {
      rec.set('state', 'new');
    } else if (mapped.state) {
      if (!S.canTransition('new', mapped.state)) {
        throw K.fail(422, 'INVALID_STATE_TRANSITION',
          '新记录不允许直接落 ' + mapped.state, { allowed: K.TRANSITIONS['new'] });
      }
      rec.set('state', mapped.state);
      rec.set('verdict', mapped.verdict);
      rec.set('verified_at', new Date().toISOString());
    }
    try {
      $app.save(rec);
    } catch (err) {
      throw K.fail(500, 'SAVE_FAILED', '上报落库失败', { detail: String(err).slice(0, 300) });
    }

    if (supersedes) {
      supersedes.set('superseded_by', rec.id);
      if (body.reopened_reason) supersedes.set('reopened_reason', String(body.reopened_reason));
      try { $app.save(supersedes); } catch (e) { /* ignore */ }
    }

    K.audit('queue', 'ingest', {
      agent_name: agent.name, item_id: rec.id, status: 201, scope_id: scopeRes.scope_id,
    });

    const payload = {
      item: SER.item(rec, { cache: { targets: {}, evidence: {} } }),
      deduplicated: false,
      rubric_warnings: rubric.warnings,
      rate_limit: rate,
    };
    IDEM.finish(agent.id, 'POST /api/verification/queue', idem && idem.key, idem && idem.hash, 201, payload);
    return K.ok(c, payload, 201);
  });
}

/* ───────────────────────── PATCH 回写判定 ───────────────────────── */

function requireIfMatch(c, info, record) {
  const raw = K.header(info, 'if-match');
  const current = SER.etagOf(record);
  if (!raw) {
    throw K.fail(428, 'PRECONDITION_REQUIRED',
      '回写判定必须带 If-Match: <etag>（etag 从拉队列/领取的响应里拿，防止覆盖别人的更新）', {
      current_etag: current,
    });
  }
  const want = String(raw).trim().replace(/^W\//, '');
  if (want !== current) {
    throw K.fail(412, 'PRECONDITION_FAILED',
      '实体已被更新（若这是租约/心跳造成的时间戳变化不会影响 etag；内容被改过请重新拉一次再回写）', {
      current_etag: current, provided: want,
    });
  }
}

/** 取租约 token：body.lease_token 优先，其次 Lease-Token 头 */
function leaseTokenFrom(info, body) {
  const fromBody = body && body.lease_token ? String(body.lease_token) : '';
  if (fromBody) return fromBody;
  return K.header(info, 'lease-token');
}

function patch(c) {
  return K.guard(c, () => {
    const info = K.reqInfo(c);
    K.assertContractVersion(info);
    const agent = A.requireAgent(info, 'review');
    const rate = RATE.check(agent);
    const body = K.bodyObject(c, info);
    const id = String(c.request.pathValue('id') || '');
    if (!id) throw K.fail(422, 'VALIDATION_FAILED', '缺少记录 id');

    let record = null;
    try { record = $app.findRecordById('review_queue', id); } catch (e) { record = null; }
    if (!record) throw K.fail(404, 'NOT_FOUND', '记录不存在', { id: id });
    if (String(record.get('superseded_by') || '')) {
      throw K.fail(409, 'ALREADY_SUPERSEDED', '该记录已被新记录取代，请去更新 superseded_by 指向的那条', {
        superseded_by: String(record.get('superseded_by')),
      });
    }

    requireIfMatch(c, info, record);
    const at = new Date();
    reclaimIfExpired(record, at);

    const extState = String(body.state || '').trim().toLowerCase();
    if (K.EXTERNAL_STATES.indexOf(extState) < 0) {
      throw K.fail(422, 'INVALID_STATE', 'state 只接受 ' + K.EXTERNAL_STATES.join(' / '), { got: extState });
    }
    const currentExternal = S.externalOf(record, at);

    // 授权范围在提交点再验一次（中途过期 → 任务作废）
    const scopeRes = SC.resolve({
      endpoint: String(record.get('endpoint_norm') || record.get('endpoint') || record.get('url') || ''),
      target: String(record.get('url') || ''),
      scope_id: record.get('scope'),
    });
    if (!scopeRes.in_scope) {
      clearLease(record);
      record.set('contract_note', 'scope_abort@patch:' + scopeRes.reason);
      try { $app.save(record); } catch (e) { /* ignore */ }
      K.audit('queue', 'scope_abort', {
        agent_name: agent.name, item_id: id, status: 409, code: 'SCOPE_EXPIRED',
        detail: String(scopeRes.reason), scope_id: String(scopeRes.scope_id || ''),
      });
      throw K.fail(409, 'SCOPE_EXPIRED',
        '任务作废：该目标已不在有效授权范围内（范围在 claim / heartbeat / 提交三个点都会校验）', {
        reason: scopeRes.reason, scope_id: scopeRes.scope_id || '',
      });
    }

    // 租约校验：改判定的写入必须持有效租约
    const token = leaseTokenFrom(info, body);
    const holder = String(record.get('claimed_by') || '');
    const active = S.leaseActive(record, at);
    if (extState !== 'suspected' || body.require_lease === true) {
      if (!token || !active) {
        throw K.fail(409, 'NO_LEASE',
          '没有有效租约：先 POST /api/verification/queue/' + id + '/claim 领取，再回写', {
          lease: S.leaseJson(record, at),
        });
      }
      if (String(record.get('lease_token')) !== token) {
        throw K.fail(409, 'LEASE_EXPIRED',
          '租约已失效（超时被回收或被他人重新领取），旧 token 一律作废，请重新领取', {
          lease: S.leaseJson(record, at),
        });
      }
    }

    const mapped = S.internalForExternal(extState, body);
    const evidenceRefs = validateEvidenceRefs(readPayloadArray(body, 'evidence'));
    const steps = readPayloadArray(body, 'reproduction_steps');
    const checks = readPayloadArray(body, 'checks');
    const confidence = body.confidence === undefined ? Number(record.get('confidence') || 0) : Number(body.confidence);
    const kind = String(record.get('rule_id') || '');

    const rubric = RUB.checkVerdict(kind, extState, {
      reproduction_steps: steps, evidenceRefs: evidenceRefs, confidence: confidence,
      checks: checks, verdict_note: body.verdict_note, curl: body.curl, reason_code: body.reason_code,
    });
    if (rubric.errors.length) {
      throw K.fail(422, 'RUBRIC_VIOLATION',
        '不满足「' + kind + '」的判定准则：' + rubric.errors[0].message, {
        rubric: rubric.rubric, errors: rubric.errors, warnings: rubric.warnings,
        current_etag: SER.etagOf(record),
      });
    }

    if (extState === 'suspected') {
      if (S.isTerminalExternal(currentExternal)) {
        throw K.fail(409, 'TERMINAL_IMMUTABLE',
          '终态不可原地回退：要推翻已签字结论，请 POST 一条带 supersedes=' + id + ' 的新记录（证据链才不断）', {
          current_state: currentExternal, current_etag: SER.etagOf(record), reopen_with: { supersedes: id },
        });
      }
      if (!S.agentCanWrite(String(record.get('state')), 'retest')) {
        throw K.fail(422, 'INVALID_STATE_TRANSITION', '当前状态不允许退回待验证', {
          internal_state: String(record.get('state')), allowed: K.TRANSITIONS[String(record.get('state'))] || [],
        });
      }
      record.set('state', 'retest');
      record.set('verdict', 'need_retest');
    } else if (extState === 'testing') {
      record.set('contract_note', 'testing@' + new Date().toISOString());
    } else {
      const cur = String(record.get('state'));
      if (S.isHumanTerminal(cur)) {
        throw K.fail(409, 'TERMINAL_IMMUTABLE',
          '该记录已经人工签字定论（' + cur + '），Agent 不能原地改判；要推翻请 POST 一条带 supersedes=' + id + ' 的新记录', {
          internal_state: cur, current_state: currentExternal,
          current_etag: SER.etagOf(record), reopen_with: { supersedes: id },
        });
      }
      if (!S.agentCanWrite(cur, mapped.state)) {
        throw K.fail(422, 'INVALID_STATE_TRANSITION',
          '不允许从 ' + cur + ' 迁到 ' + mapped.state, {
          internal_state: cur, target: mapped.state, allowed: K.TRANSITIONS[cur] || [],
        });
      }
      record.set('state', mapped.state);
      record.set('verdict', mapped.verdict);
      record.set('verified_at', new Date().toISOString());
    }

    if (evidenceRefs.length) record.set('evidence_ids', evidenceRefs.map((e) => e.id));
    if (steps.length) record.set('reproduction_steps', steps);
    if (checks.length) record.set('checks', JSON.stringify(checks));
    if (body.verdict_note !== undefined) record.set('verdict_note', String(body.verdict_note || ''));
    if (body.curl !== undefined) record.set('curl', String(body.curl || ''));
    if (body.raw_request !== undefined) record.set('raw_request', String(body.raw_request || ''));
    if (body.raw_response !== undefined) record.set('raw_response', String(body.raw_response || ''));
    if (body.confidence !== undefined) record.set('confidence', confidence);
    if (body.parameter !== undefined) record.set('parameter', String(body.parameter || ''));
    if (body.location !== undefined) record.set('location', String(body.location || ''));
    if (body.severity !== undefined) record.set('severity', String(body.severity || ''));
    record.set('agent_name', agent.name);
    record.set('attempts', Number(record.get('attempts') || 0) + 1);
    record.set('contract_note', 'verdict@' + new Date().toISOString());
    clearLease(record);

    try {
      $app.save(record);
    } catch (err) {
      throw K.fail(500, 'SAVE_FAILED', '回写失败', { detail: String(err).slice(0, 300) });
    }
    K.audit('queue', 'verdict', {
      agent_name: agent.name, item_id: record.id, status: 200, scope_id: String(scopeRes.scope_id || ''),
      code: extState,
    });

    return K.ok(c, {
      item: SER.item(record, { cache: { targets: {}, evidence: {} } }),
      rubric_warnings: rubric.warnings,
      rubric: rubric.rubric,
      rate_limit: rate,
    });
  });
}

/* ───────────────────────── 领取 / 心跳 / 释放 ───────────────────────── */

function loadForLease(c, info, needToken) {
  const id = String(c.request.pathValue('id') || '');
  let record = null;
  try { record = $app.findRecordById('review_queue', id); } catch (e) { record = null; }
  if (!record) throw K.fail(404, 'NOT_FOUND', '记录不存在', { id: id });
  if (String(record.get('superseded_by') || '')) {
    throw K.fail(409, 'ALREADY_SUPERSEDED', '该记录已被新记录取代', {
      superseded_by: String(record.get('superseded_by')),
    });
  }
  return record;
}

function requireScopeOrAbort(record, agent, action) {
  const res = SC.resolve({
    endpoint: String(record.get('endpoint_norm') || record.get('endpoint') || record.get('url') || ''),
    target: String(record.get('url') || ''),
    scope_id: record.get('scope'),
  });
  if (!res.in_scope) {
    clearLease(record);
    record.set('contract_note', 'scope_abort@' + action + ':' + res.reason);
    try { $app.save(record); } catch (e) { /* ignore */ }
    K.audit('queue', 'scope_abort', {
      agent_name: agent.name, item_id: record.id, status: 409, code: 'SCOPE_EXPIRED',
      detail: String(res.reason), scope_id: String(res.scope_id || ''),
    });
    throw K.fail(409, 'SCOPE_EXPIRED',
      '任务作废：目标已不在有效授权范围内（claim / heartbeat / 提交三个点都会校验）', {
      reason: res.reason, scope_id: res.scope_id || '',
    });
  }
  return res;
}

function claim(c) {
  return K.guard(c, () => {
    const info = K.reqInfo(c);
    K.assertContractVersion(info);
    const agent = A.requireAgent(info, 'review');
    const rate = RATE.check(agent);
    const body = K.bodyObject(c, info);
    const record = loadForLease(c, info);
    const at = new Date();
    reclaimIfExpired(record, at);

    const workerId = String(body.worker_id || agent.name);
    const leaseSeconds = Math.min(MAX_LEASE_SECONDS,
      Math.max(30, Number(body.lease_seconds || DEFAULT_LEASE_SECONDS)));

    const scopeRes = requireScopeOrAbort(record, agent, 'claim');

    const currentExternal = S.externalOf(record, at);
    if (currentExternal === 'confirmed' || currentExternal === 'rejected') {
      throw K.fail(409, 'ALREADY_FINAL',
        '该记录已是终态（' + currentExternal + '），不需要再验证', { state: currentExternal });
    }

    const active = S.leaseActive(record, at);
    const holder = String(record.get('claimed_by') || '');
    let token = String(record.get('lease_token') || '');
    if (active && holder && holder !== agent.name && workerId !== holder) {
      throw K.fail(409, 'ALREADY_CLAIMED', '该记录已被 ' + holder + ' 领取，未超时不可重复领取', {
        leased_by: holder, lease: S.leaseJson(record, at),
      });
    }
    if (!active || !token) {
      token = String($security.randomStringWithAlphabet(32, 'abcdef0123456789'));
    }
    const expires = K.addSeconds(new Date(), leaseSeconds);
    record.set('lease_token', token);
    record.set('claimed_by', workerId);
    record.set('heartbeat_at', new Date().toISOString());
    record.set('lease_expires_at', expires.toISOString());
    try {
      $app.save(record);
    } catch (err) {
      throw K.fail(500, 'SAVE_FAILED', '领取失败', { detail: String(err).slice(0, 300) });
    }
    K.audit('queue', 'claim', {
      agent_name: agent.name, item_id: record.id, status: 200, scope_id: String(scopeRes.scope_id || ''),
    });

    return K.ok(c, {
      lease_token: token,
      lease_expires_at: K.isoOf(record.get('lease_expires_at')),
      lease_seconds: leaseSeconds,
      item: SER.item(record, { at: at, cache: { targets: {}, evidence: {} } }),
      rate_limit: rate,
    });
  });
}

function heartbeat(c) {
  return K.guard(c, () => {
    const info = K.reqInfo(c);
    K.assertContractVersion(info);
    const agent = A.requireAgent(info, 'review');
    const rate = RATE.check(agent);
    const body = K.bodyObject(c, info);
    const record = loadForLease(c, info);
    const at = new Date();

    const token = leaseTokenFrom(info, body);
    const stored = String(record.get('lease_token') || '');
    if (!stored || !token || stored !== token) {
      throw K.fail(409, 'LEASE_EXPIRED',
        '租约已失效（超时被回收或已被他人领取），旧 token 一律作废', {
        lease: S.leaseJson(record, at), token_matched: false,
      });
    }
    if (!S.leaseActive(record, at)) {
      clearLease(record);
      try { $app.save(record); } catch (e) { /* ignore */ }
      throw K.fail(409, 'LEASE_EXPIRED', '租约已超时，请重新领取', { lease: S.leaseJson(record, at) });
    }
    const scopeRes = requireScopeOrAbort(record, agent, 'heartbeat');

    const leaseSeconds = Math.min(MAX_LEASE_SECONDS,
      Math.max(30, Number(body.lease_seconds || DEFAULT_LEASE_SECONDS)));
    record.set('lease_expires_at', K.addSeconds(new Date(), leaseSeconds).toISOString());
    record.set('heartbeat_at', new Date().toISOString());
    try {
      $app.save(record);
    } catch (err) {
      throw K.fail(500, 'SAVE_FAILED', '续租失败', { detail: String(err).slice(0, 300) });
    }
    return K.ok(c, {
      lease_token: stored,
      lease_expires_at: K.isoOf(record.get('lease_expires_at')),
      lease_seconds: leaseSeconds,
      in_scope: true,
      scope_id: scopeRes.scope_id || '',
      rate_limit: rate,
    });
  });
}

function release(c) {
  return K.guard(c, () => {
    const info = K.reqInfo(c);
    K.assertContractVersion(info);
    const agent = A.requireAgent(info, 'review');
    const rate = RATE.check(agent);
    const body = K.bodyObject(c, info);
    const record = loadForLease(c, info);
    const at = new Date();

    const token = leaseTokenFrom(info, body);
    const stored = String(record.get('lease_token') || '');
    if (stored && token && stored !== token) {
      throw K.fail(409, 'LEASE_EXPIRED', '租约已失效，旧 token 作废', { lease: S.leaseJson(record, at) });
    }
    const reason = String(body.reason || 'released');
    clearLease(record);
    record.set('contract_note', 'release:' + reason + '@' + new Date().toISOString());
    try { $app.save(record); } catch (e) { /* ignore */ }
    K.audit('queue', 'release', { agent_name: agent.name, item_id: record.id, status: 200, detail: reason });
    return K.ok(c, {
      item: SER.item(record, { at: at, cache: { targets: {}, evidence: {} } }),
      released: true,
      rate_limit: rate,
    });
  });
}

module.exports = {
  list: list,
  getOne: getOne,
  create: create,
  patch: patch,
  claim: claim,
  heartbeat: heartbeat,
  release: release,
};
