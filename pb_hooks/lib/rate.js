/**
 * ReconLab 契约层 · 限流
 *
 * 默认 60 req/min/worker（可用环境变量 RECONLAB_RATE_LIMIT 覆盖）。
 * 超限一律 429 + Retry-After（秒），Agent 照着退避即可。
 * 计数按「Agent + 分钟窗口」落库，多实例、多池都算得准。
 */

const K = require('./kit.js');

const WINDOW_MS = 60000;

function check(agent) {
  const limit = K.rateLimitPerMinute();
  const now = Date.now();
  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const windowEnd = windowStart + WINDOW_MS;
  const bucket = agent.id + ':' + windowStart;

  let record = null;
  try {
    record = $app.findFirstRecordByFilter('rate_buckets', 'bucket = {:b}', { b: bucket });
  } catch (e) {
    record = null;
  }

  let count = 0;
  if (record) {
    count = Number(record.get('count') || 0) + 1;
    record.set('count', count);
    try { $app.save(record); } catch (e) { /* 计数落库失败不阻塞请求 */ }
  } else {
    count = 1;
    try {
      const col = $app.findCollectionByNameOrId('rate_buckets');
      const rec = new Record(col);
      rec.set('bucket', bucket);
      rec.set('agent', agent.id);
      rec.set('agent_name', agent.name);
      rec.set('window_start', windowStart);
      rec.set('count', count);
      $app.save(rec);
    } catch (e) { /* ignore */ }
  }

  if (count > limit) {
    const retryAfter = Math.max(1, Math.ceil((windowEnd - now) / 1000));
    throw K.fail(429, 'RATE_LIMITED',
      '请求过于频繁：' + limit + ' req/min/worker，请按 Retry-After 退避重试', {
      limit: limit, retry_after: retryAfter, window_seconds: 60,
    });
  }
  return {
    limit: limit,
    remaining: Math.max(0, limit - count),
    reset_seconds: Math.max(1, Math.ceil((windowEnd - now) / 1000)),
  };
}

/** 清理旧窗口，避免表无限增长（定时任务调用） */
function cleanup(keepHours) {
  const hours = keepHours || 6;
  let removed = 0;
  try {
    const until = new Date(Date.now() - hours * 3600 * 1000).getTime();
    const recs = $app.findRecordsByFilter('rate_buckets', 'window_start < {:t}', '', 500, 0, { t: until });
    for (let i = 0; i < recs.length; i++) {
      $app.delete(recs[i]);
      removed += 1;
    }
  } catch (e) { /* ignore */ }
  return removed;
}

module.exports = { check: check, cleanup: cleanup, WINDOW_MS: WINDOW_MS };
