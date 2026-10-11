/**
 * ReconLab 契约层 · 授权范围接口
 *   GET  /api/scopes            列出全部授权范围（含是否生效）
 *   GET  /api/scopes/{id}       单个范围
 *   POST /api/scope/check       给任意 URL/跳转链做范围校验（重定向逐跳校验直接用这个）
 */

const K = require('../lib/kit.js');
const A = require('../lib/auth.js');
const SC = require('../lib/scope.js');
const RATE = require('../lib/rate.js');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function list(c) {
  return K.guard(c, () => {
    const info = K.reqInfo(c);
    K.assertContractVersion(info);
    const agent = A.requireAgent(info, null);
    const rate = RATE.check(agent);
    const limit = K.qInt(info, 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT);
    const cursor = K.decodeCursor(K.qStr(info, 'cursor'));
    const statusFilter = K.qStr(info, 'status');

    let recs = [];
    try {
      recs = $app.findRecordsByFilter('scopes', '1=1', 'created,id', 500, 0);
    } catch (e) {
      throw K.fail(500, 'QUERY_FAILED', '读取授权范围失败', { detail: String(e).slice(0, 200) });
    }
    let items = recs.map(SC.scopeToJson);
    if (statusFilter === 'active') items = items.filter((s) => s.active);
    if (statusFilter === 'expired') items = items.filter((s) => !s.active);
    if (cursor && cursor.i) {
      const idx = items.map((s) => s.id).indexOf(String(cursor.i));
      items = idx >= 0 ? items.slice(idx + 1) : items;
    }
    let nextCursor = null;
    if (items.length > limit) {
      items = items.slice(0, limit);
      nextCursor = K.encodeCursor({ i: items[items.length - 1].id });
    }
    return K.ok(c, {
      items: items,
      count: items.length,
      next_cursor: nextCursor,
      rate_limit: rate,
    });
  });
}

function get(c) {
  return K.guard(c, () => {
    const info = K.reqInfo(c);
    K.assertContractVersion(info);
    const agent = A.requireAgent(info, null);
    RATE.check(agent);
    const id = String(c.request.pathValue('id') || '');
    let rec = null;
    try { rec = $app.findRecordById('scopes', id); } catch (e) { rec = null; }
    if (!rec) throw K.fail(404, 'SCOPE_NOT_FOUND', '授权范围不存在', { id: id });
    return K.ok(c, { scope: SC.scopeToJson(rec) });
  });
}

function check(c) {
  return K.guard(c, () => {
    const info = K.reqInfo(c);
    K.assertContractVersion(info);
    const agent = A.requireAgent(info, null);
    const rate = RATE.check(agent);
    const body = K.bodyObject(c, info);

    const urls = [];
    if (body.urls && Object.prototype.toString.call(body.urls) === '[object Array]') {
      for (let i = 0; i < body.urls.length; i++) urls.push(String(body.urls[i]));
    }
    if (body.url) urls.push(String(body.url));
    const target = String(body.target || '');
    if (!urls.length && !target) {
      throw K.fail(422, 'VALIDATION_FAILED', '至少要给 url / urls / target 之一');
    }
    if (!urls.length) urls.push(target);

    const results = [];
    let allIn = true;
    for (let i = 0; i < urls.length; i++) {
      const u = urls[i];
      const res = SC.resolve({ endpoint: u, target: target, scope_id: body.scope_id });
      if (!res.in_scope) allIn = false;
      results.push({
        url: u,
        normalized: SC.normalizeEndpoint(u) || u,
        in_scope: res.in_scope,
        reason: res.reason || '',
        scope_id: res.scope_id || '',
        matched_asset: res.asset ? { type: String(res.asset.type || ''), value: String(res.asset.value || '') } : null,
      });
    }

    if (!allIn) {
      K.audit('scope', 'check_denied', {
        agent_name: agent.name, status: 403, code: 'OUT_OF_SCOPE',
        detail: JSON.stringify(results).slice(0, 800),
      });
    }
    return K.ok(c, {
      in_scope: allIn,
      hop_count: results.length,
      results: results,
      rule: '重定向每一跳都要过范围；任何一跳越界即中止，不要继续跟',
      rate_limit: rate,
    }, allIn ? 200 : 403);
  });
}

module.exports = { list: list, get: get, check: check };
