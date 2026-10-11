/**
 * ReconLab 契约层 · 判定准则表接口 + 契约元信息
 *   GET /api/rubrics          全部判定准则
 *   GET /api/rubrics/{kind}   单个漏洞类型的判定门槛
 *   GET /api/contract/meta    契约自描述（词表、映射表、限制、错误码、端点）
 */

const K = require('../lib/kit.js');
const A = require('../lib/auth.js');
const RUB = require('../lib/rubric.js');
const RATE = require('../lib/rate.js');

function list(c) {
  return K.guard(c, () => {
    const info = K.reqInfo(c);
    K.assertContractVersion(info);
    const agent = A.requireAgent(info, null);
    const rate = RATE.check(agent);
    const items = RUB.allRubrics().map(RUB.rubricJson);
    return K.ok(c, { items: items, count: items.length, rate_limit: rate });
  });
}

function get(c) {
  return K.guard(c, () => {
    const info = K.reqInfo(c);
    K.assertContractVersion(info);
    const agent = A.requireAgent(info, null);
    RATE.check(agent);
    const kind = String(c.request.pathValue('kind') || '');
    const rubric = RUB.getRubric(kind) || RUB.getRubric(RUB.DEFAULT_KIND);
    if (!rubric) throw K.fail(404, 'RUBRIC_NOT_FOUND', '没有该 kind 的判定准则', { kind: kind });
    return K.ok(c, { rubric: RUB.rubricJson(rubric), exact_match: String(rubric.get('rule_id')) === kind });
  });
}

function meta(c) {
  return K.guard(c, () => {
    const info = K.reqInfo(c);
    K.assertContractVersion(info);
    const agent = A.requireAgent(info, null);
    const rate = RATE.check(agent);
    const kinds = RUB.allRubrics().map((r) => String(r.get('rule_id')));
    return K.ok(c, {
      contract_version: K.CONTRACT_VERSION,
      states: {
        external: K.EXTERNAL_STATES,
        terminal: ['confirmed', 'rejected'],
        internal_count: K.INTERNAL_STATES.length,
      },
      state_mapping: {
        'new': 'suspected',
        'normalized': 'suspected',
        'retest': 'suspected',
        'awaiting_human': 'testing',
        'auto_verified': 'confirmed/rejected/inconclusive（按 verdict 收敛）',
        'uncertain': 'inconclusive',
        'confirmed': 'confirmed',
        'rejected': 'rejected',
        note: '对外 5 态是视图；站内复核机（含人工签字位）原样保留，Agent 看不到内部状态',
      },
      write_states: {
        suspected: '退回待验证（终态记录必须用 supersedes 重开）',
        testing: '表示「正在验」，需持租约',
        confirmed: '必须带 reproduction_steps + 至少一条 evidence，且满足判定准则',
        rejected: '必须写 verdict_note 说明否定依据',
        inconclusive: '必须写 verdict_note 说明卡点（环境受限/未投递成功）',
      },
      scan_states: ['queued', 'running', 'done', 'failed'],
      kinds: kinds,
      limits: {
        rate_limit_per_minute: K.rateLimitPerMinute(),
        page_size_max: 100,
        default_page_size: 20,
        lease_seconds_default: 900,
        lease_seconds_max: 3600,
        evidence_inline_hash_max_bytes: 8 * 1024 * 1024,
      },
      capabilities: {
        idempotency: 'POST 接口要求 Idempotency-Key（稳定 UUID，重试原样复用）',
        optimistic_lock: 'PATCH 要求 If-Match: <etag>，已随每次读返回',
        claim_lease: 'claim / heartbeat / release，回收后旧 token 立即作废',
        scope_enforcement: 'claim / heartbeat / 提交三点都校验，重定向逐跳走 /api/scope/check',
        evidence_digest: '上传必须带 Content-Digest 或 X-Content-SHA256，服务端自算比对',
        reopen: 'POST 新记录并带 supersedes=<旧 id>，形成证据链而不是原地改历史',
      },
      error_codes: [
        'UNAUTHORIZED', 'AGENT_KEY_INVALID', 'AGENT_DISABLED', 'PERMISSION_DENIED',
        'OUT_OF_SCOPE', 'SCOPE_EXPIRED', 'SCOPE_NOT_FOUND',
        'VALIDATION_FAILED', 'INVALID_STATE', 'INVALID_STATE_TRANSITION', 'INVALID_ENDPOINT',
        'RUBRIC_VIOLATION', 'EVIDENCE_NOT_FOUND', 'EVIDENCE_HASH_MISMATCH',
        'IDEMPOTENCY_KEY_REQUIRED', 'IDEMPOTENCY_CONFLICT',
        'ALREADY_CLAIMED', 'LEASE_EXPIRED', 'NO_LEASE', 'ALREADY_FINAL',
        'TERMINAL_IMMUTABLE', 'ALREADY_SUPERSEDED',
        'PRECONDITION_REQUIRED', 'PRECONDITION_FAILED', 'RATE_LIMITED',
        'DIGEST_REQUIRED', 'DIGEST_INVALID', 'DIGEST_MISMATCH', 'MISSING_FILE', 'INVALID_MULTIPART',
        'BUDGET_EXHAUSTED', 'SCAN_FAILED',
      ],
      endpoints: [
        { method: 'GET', path: '/api/verification/queue', auth: 'review' },
        { method: 'POST', path: '/api/verification/queue', auth: 'ingest', idempotency_required: true },
        { method: 'PATCH', path: '/api/verification/queue/{id}', auth: 'review', if_match_required: true },
        { method: 'POST', path: '/api/verification/queue/{id}/claim', auth: 'review' },
        { method: 'POST', path: '/api/verification/queue/{id}/heartbeat', auth: 'review' },
        { method: 'POST', path: '/api/verification/queue/{id}/release', auth: 'review' },
        { method: 'POST', path: '/api/evidence', auth: 'ingest', digest_required: true },
        { method: 'GET', path: '/api/evidence/{id}', auth: 'any' },
        { method: 'GET', path: '/api/evidence/{id}/raw', auth: 'any' },
        { method: 'GET', path: '/api/scopes', auth: 'any' },
        { method: 'GET', path: '/api/scopes/{id}', auth: 'any' },
        { method: 'POST', path: '/api/scope/check', auth: 'any' },
        { method: 'GET', path: '/api/rubrics', auth: 'any' },
        { method: 'GET', path: '/api/rubrics/{kind}', auth: 'any' },
        { method: 'POST', path: '/api/scans', auth: 'scan', idempotency_required: true },
        { method: 'GET', path: '/api/scans/{id}', auth: 'scan' },
        { method: 'GET', path: '/api/scans/{id}/findings', auth: 'scan' },
      ],
      agent: { name: agent.name, scopes: agent.scopes },
      rate_limit: rate,
    });
  });
}

module.exports = { list: list, get: get, meta: meta };
