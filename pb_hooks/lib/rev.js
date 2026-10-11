/**
 * ReconLab 契约层 · 实体版本（rev / ETag）维护
 *
 * 为什么不用 PocketBase 自带的 updated 当 ETag：
 *   租约、心跳、内部回填都会动 updated，Agent 就会莫名吃 412。
 * 这里的做法是「内容寻址的版本号」：
 *   把对 Agent 可见的字段拼起来算个指纹，指纹变了才推进 rev；
 *   租约/心跳这类不影响内容的写入推不动 rev，If-Match 也就不会误伤。
 */

const K = require('./kit.js');

function val(record, field) {
  const v = record.get(field);
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }
  return String(v);
}

function stamp(record) {
  const parts = [];
  for (let i = 0; i < K.CONTENT_FIELDS.length; i++) {
    const f = K.CONTENT_FIELDS[i];
    parts.push(f + '=' + val(record, f));
  }
  return String($security.sha256(parts.join('\u0001')));
}

function onCreate(record) {
  record.set('content_stamp', stamp(record));
  record.set('rev', 1);
}

function onUpdate(record) {
  const next = stamp(record);
  const prev = String(record.get('content_stamp') || '');
  if (next !== prev) {
    record.set('content_stamp', next);
    record.set('rev', Number(record.get('rev') || 0) + 1);
  }
}

module.exports = { stamp: stamp, onCreate: onCreate, onUpdate: onUpdate };
