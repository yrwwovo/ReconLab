/**
 * ReconLab 契约层 · 幂等
 *
 * 规矩（契约 v2 定死的）:
 *   - Idempotency-Key 必须是客户端自己生成的稳定 UUID，**重试时原样复用**。
 *   - 内容哈希只用来校验「同一个 key 是不是同一个请求」，绝不拿它当幂等键
 *     （拿内容当键 = 包里多一个 timestamp 就变成新请求，幂等直接失效）。
 *   - 同 key 同内容 → 直接回放首次结果，不重复建记录。
 *   - 同 key 不同内容 → 409 IDEMPOTENCY_CONFLICT。
 *   - 失败的请求不落幂等记录，允许重试。
 */

const K = require('./kit.js');

const TTL_SECONDS = 24 * 3600;

function sha256Hex(s) {
  return String($security.sha256(String(s)));
}

/** 稳定序列化：键排序，保证同一份内容永远得到同一个哈希 */
function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  const t = Object.prototype.toString.call(value);
  if (t === '[object Array]') {
    const parts = [];
    for (let i = 0; i < value.length; i++) parts.push(stableStringify(value[i]));
    return '[' + parts.join(',') + ']';
  }
  if (t === '[object Object]') {
    const keys = Object.keys(value).sort();
    const parts = [];
    for (let i = 0; i < keys.length; i++) parts.push(JSON.stringify(keys[i]) + ':' + stableStringify(value[keys[i]]));
    return '{' + parts.join(',') + '}';
  }
  return JSON.stringify(value);
}

function requestHash(payload) {
  return sha256Hex(stableStringify(payload));
}

function validateKey(raw) {
  const key = String(raw || '').trim();
  if (key.length < 8) {
    throw K.fail(422, 'VALIDATION_FAILED', 'Idempotency-Key 太短，要用客户端生成的稳定 UUID', { field: 'Idempotency-Key' });
  }
  if (key.length > 200) {
    throw K.fail(422, 'VALIDATION_FAILED', 'Idempotency-Key 太长', { field: 'Idempotency-Key' });
  }
  return key;
}

function lookup(agentId, key) {
  try {
    return $app.findFirstRecordByFilter('idempotency_keys',
      'agent = {:a} && idem_key = {:k}', { a: agentId, k: key });
  } catch (e) {
    return null;
  }
}

/**
 * 进入幂等检查。返回：
 *   null                       —— 没带 key（仅在非必需接口出现）
 *   {replay:true, status, body}—— 命中，直接回放
 *   {replay:false, key, hash}  —— 放行，处理完记得 finish()
 */
function begin(info, agent, endpoint, payload, required) {
  const raw = K.header(info, 'idempotency-key');
  if (!raw) {
    if (required) {
      throw K.fail(400, 'IDEMPOTENCY_KEY_REQUIRED',
        '该接口要求 Idempotency-Key 头（客户端生成稳定 UUID，重试时原样复用）', {
        field: 'Idempotency-Key', endpoint: endpoint,
      });
    }
    return null;
  }
  const key = validateKey(raw);
  const hash = requestHash(payload);
  const existing = lookup(agent.id, key);
  if (!existing) return { replay: false, key: key, hash: hash };

  const storedHash = String(existing.get('request_hash') || '');
  if (storedHash !== hash) {
    throw K.fail(409, 'IDEMPOTENCY_CONFLICT',
      '同一个 Idempotency-Key 被用于了不同内容；重试请复用原来的 key 和原样的请求体', {
      idempotency_key: key,
    });
  }
  let body = null;
  try {
    body = K.jsonValue(existing.get('response'));
  } catch (e) {
    body = null;
  }
  if (!body) return { replay: false, key: key, hash: hash };
  return { replay: true, status: Number(existing.get('status') || 200), body: body, idempotency_key: key };
}

/** 处理成功后落幂等记录 */
function finish(agentId, endpoint, key, hash, status, body, ttlSeconds) {
  if (!key) return;
  try {
    const col = $app.findCollectionByNameOrId('idempotency_keys');
    const rec = new Record(col);
    rec.set('agent', agentId);
    rec.set('idem_key', key);
    rec.set('endpoint', endpoint);
    rec.set('request_hash', hash);
    rec.set('status', status);
    rec.set('response', JSON.stringify(body));
    rec.set('expires_at', K.addSeconds(new Date(), (ttlSeconds && ttlSeconds > 0) ? ttlSeconds : TTL_SECONDS).toISOString());
    $app.save(rec);
  } catch (e) {
    K.audit('idempotency', 'persist_failed', { detail: String(e), agent_name: agentId, status: status });
  }
}

/** 清理过期的幂等记录（定时任务调用） */
function cleanup() {
  let removed = 0;
  try {
    const now = new Date().toISOString();
    const recs = $app.findRecordsByFilter('idempotency_keys', 'expires_at < {:n}', '', 500, 0, { n: now });
    for (let i = 0; i < recs.length; i++) {
      $app.delete(recs[i]);
      removed += 1;
    }
  } catch (e) { /* ignore */ }
  return removed;
}

module.exports = {
  TTL_SECONDS: TTL_SECONDS,
  stableStringify: stableStringify,
  requestHash: requestHash,
  begin: begin,
  finish: finish,
  cleanup: cleanup,
};
