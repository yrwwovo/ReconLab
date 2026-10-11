/**
 * ReconLab 契约层 · 记录 → 契约 JSON
 *
 * 对外只暴露契约里的字段；内部状态机的细节不外泄，
 * 只给一个信息性 review_status（pending_platform_review / signed_off）。
 */

const K = require('./kit.js');
const S = require('./state.js');
const SC = require('./scope.js');

function safeJson(value) {
  const v = K.jsonValue(value);
  return v === null ? [] : v;
}

function getText(record, name) {
  const v = record.get(name);
  if (v === null || v === undefined) return '';
  return String(v);
}

function getArray(record, name) {
  return K.asArray(record.get(name));
}

/** 实体版本 → ETag：只随「对 Agent 可见的内容」变化，租约/心跳推不动它 */
function etagOf(record) {
  const rev = Number(record.get('rev') || 0);
  return '"' + record.id + '-' + rev + '"';
}

function evidenceRefs(record, cache) {
  const out = [];
  const ids = Object.prototype.toString.call(cache) === '[object Object]' ? cache : {};
  const list = getArray(record, 'evidence_ids');
  for (let i = 0; i < list.length; i++) {
    const ref = list[i];
    const id = typeof ref === 'string' ? ref : String((ref && ref.id) || '');
    if (!id) continue;
    let rec = ids[id];
    if (rec === undefined) {
      try {
        rec = $app.findRecordById('evidence', id);
      } catch (e) {
        rec = null;
      }
      ids[id] = rec;
    }
    if (!rec) {
      out.push({ id: id, sha256: '', kind: '', note: '', missing: true });
      continue;
    }
    out.push({
      id: rec.id,
      sha256: getText(rec, 'sha256'),
      size: Number(rec.get('size') || 0),
      content_type: getText(rec, 'content_type'),
      kind: getText(rec, 'kind'),
      note: getText(rec, 'note'),
      digest_verified: !!rec.get('digest_verified'),
      created: K.isoOf(rec.get('created')),
      url: '/api/evidence/' + rec.id + '/raw',
    });
  }
  return out;
}

function targetValue(record, cache) {
  const rel = record.get('target');
  const id = typeof rel === 'string' ? rel : String((rel && rel.id) || '');
  if (!id) return { id: '', value: '' };
  let rec = cache[id];
  if (rec === undefined) {
    try { rec = $app.findRecordById('targets', id); } catch (e) { rec = null; }
    cache[id] = rec;
  }
  return { id: id, value: rec ? getText(rec, 'value') : id };
}

/**
 * 单条记录的契约视图。
 * opts.cache：同一请求内复用 target/evidence 查询。
 */
function item(record, opts) {
  const options = opts || {};
  const cache = options.cache || { targets: {}, evidence: {} };
  if (!cache.targets) cache.targets = {};
  if (!cache.evidence) cache.evidence = {};
  const at = options.at || new Date();
  const state = S.externalOf(record, at);
  const tv = targetValue(record, cache.targets);
  const scopeRel = record.get('scope');
  const scopeId = typeof scopeRel === 'string' ? scopeRel : String((scopeRel && scopeRel.id) || '');

  const out = {
    id: record.id,
    kind: getText(record, 'rule_id'),
    state: state,
    review_status: S.reviewStatus(record),
    title: getText(record, 'title'),
    target: tv.value || tv.id,
    target_id: tv.id,
    scope_id: scopeId,
    endpoint: getText(record, 'endpoint_norm') || getText(record, 'endpoint') || getText(record, 'url'),
    endpoint_raw: getText(record, 'url'),
    location: getText(record, 'location'),
    parameter: getText(record, 'parameter'),
    severity: getText(record, 'severity'),
    confidence: Number(record.get('confidence') || 0),
    tier: getText(record, 'tier'),
    origin: getText(record, 'origin'),
    agent_name: getText(record, 'agent_name'),
    dedup_hash: getText(record, 'dedup_hash'),
    instances: Number(record.get('instances') || 0),
    evidence: evidenceRefs(record, cache.evidence),
    evidence_note: getText(record, 'evidence'),
    raw_request: getText(record, 'raw_request'),
    raw_response: getText(record, 'raw_response'),
    curl: getText(record, 'curl'),
    reproduction_steps: getArray(record, 'reproduction_steps'),
    verdict_note: getText(record, 'verdict_note'),
    checks: getArray(record, 'checks'),
    attempts: Number(record.get('attempts') || 0),
    reviewer: getText(record, 'reviewer'),
    verified_at: K.isoOf(record.get('verified_at')),
    rev: Number(record.get('rev') || 0),
    etag: etagOf(record),
    lease: S.leaseJson(record, at),
    supersedes: getText(record, 'supersedes'),
    superseded_by: getText(record, 'superseded_by'),
    reopened_reason: getText(record, 'reopened_reason'),
    contract_note: getText(record, 'contract_note'),
    created: K.isoOf(record.get('created')),
    updated: K.isoOf(record.get('updated')),
  };
  return out;
}

module.exports = {
  item: item,
  etagOf: etagOf,
  evidenceRefs: evidenceRefs,
  targetValue: targetValue,
  safeJson: safeJson,
  getArray: getArray,
  getText: getText,
};
