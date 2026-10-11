/**
 * ReconLab 契约层 · 证据通道
 *
 * 定死一个上传方式（不留「或」）：
 *   POST /api/evidence        multipart/form-data，文件放 file 字段；元数据走 query 或同名表单字段
 *   必须带 Content-Digest（RFC 9530: sha-256=:BASE64:）或 X-Content-SHA256（hex）
 *   服务端自算 sha256 并比对，不一致直接拒（证得了传输没截断）
 *
 *   id 归属：服务端发号（evidence.id），假设上报只引用 evidence_ids
 *   幂等：内容寻址 —— 同一个 sha256 直接复用已有记录，天然幂等
 *
 * 取证留痕：文件落 PocketBase 原生存储，控制台可直接看；
 *   Agent 侧下载走 GET /api/evidence/{id}/raw（base64，带 sha256 可校验）。
 */

const K = require('../lib/kit.js');
const A = require('../lib/auth.js');
const RATE = require('../lib/rate.js');

const MAX_INLINE_HASH_BYTES = 8 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
const MAX_INLINE_DOWNLOAD_BYTES = 12 * 1024 * 1024;

function outBytesToText(out) {
  try {
    if (Object.prototype.toString.call(out) === '[object Array]') return K.bytesToStr(out);
    return String(out);
  } catch (e) {
    return '';
  }
}

/** 找证据文件在磁盘上的落点 */
function storedPath(record) {
  const name = String(record.get('file') || '');
  if (!name) return '';
  let colId = '';
  try { colId = String($app.findCollectionByNameOrId('evidence').id); } catch (e) { colId = ''; }
  return $app.dataDir() + '/storage/' + colId + '/' + record.id + '/' + name;
}

/**
 * 自算文件 sha256。
 * 优先系统命令（内存友好），全部不可用时退回纯 JS（限中小文件）。
 */
function hashFile(path, sizeHint) {
  const attempts = [
    { name: 'sha256sum', args: [path] },
    { name: 'shasum', args: ['-a', '256', path] },
    { name: 'certutil', args: ['-hashfile', path, 'SHA256'] },
  ];
  for (let i = 0; i < attempts.length; i++) {
    const name = attempts[i].name;
    const args = attempts[i].args;
    try {
      const cmd = args.length === 1 ? $os.cmd(name, args[0])
        : args.length === 2 ? $os.cmd(name, args[0], args[1])
          : $os.cmd(name, args[0], args[1], args[2]);
      const text = outBytesToText(cmd.output());
      const m = /([0-9a-fA-F]{64})/.exec(text);
      if (m) return { sha256: m[1].toLowerCase(), method: name };
    } catch (e) { /* 换下一个 */ }
  }
  const hint = Number(sizeHint || 0);
  if (hint && hint > MAX_INLINE_HASH_BYTES) return null;
  try {
    const bytes = $os.readFile(path);
    if (bytes.length > MAX_INLINE_HASH_BYTES) return null;
    return { sha256: K.sha256Bytes(bytes), method: 'js' };
  } catch (e) {
    return null;
  }
}

function evidenceJson(record) {
  const name = String(record.get('file') || '');
  let colId = '';
  try { colId = String($app.findCollectionByNameOrId('evidence').id); } catch (e) { colId = ''; }
  return {
    id: record.id,
    sha256: String(record.get('sha256') || ''),
    size: Number(record.get('size') || 0),
    content_type: String(record.get('content_type') || ''),
    kind: String(record.get('kind') || ''),
    note: String(record.get('note') || ''),
    filename: String(record.get('original_name') || ''),
    agent_name: String(record.get('agent_name') || ''),
    digest_verified: !!record.get('digest_verified'),
    hash_method: String(record.get('hash_method') || ''),
    file_url: name && colId ? '/api/files/' + colId + '/' + record.id + '/' + name : '',
    download_url: '/api/evidence/' + record.id + '/raw',
    created: K.isoOf(record.get('created')),
  };
}

/* ───────────────────────── 上传 ───────────────────────── */

function declaredDigest(info, body) {
  const cd = K.parseContentDigest(K.header(info, 'content-digest'));
  if (cd) return { hex: cd, from: 'content-digest' };
  const raw = K.header(info, 'x-content-sha256').trim();
  if (raw && /^[0-9a-fA-F]{64}$/.test(raw)) return { hex: raw.toLowerCase(), from: 'x-content-sha256' };
  if (raw) throw K.fail(400, 'DIGEST_INVALID', 'X-Content-SHA256 必须是 64 位 hex');
  const inBody = String((body && body.sha256) || '').trim();
  if (inBody && /^[0-9a-fA-F]{64}$/.test(inBody)) return { hex: inBody.toLowerCase(), from: 'body.sha256' };
  if (inBody) throw K.fail(400, 'DIGEST_INVALID', 'body.sha256 必须是 64 位 hex');
  return null;
}

/** 文件名消毒：只留字母数字和 . _ -，避免路径拼接 */
function safeFileName(name) {
  const base = String(name || 'evidence.bin').replace(/[^A-Za-z0-9._-]/g, '_');
  return base.slice(0, 120) || 'evidence.bin';
}

/** 读回落盘后的文件再算一次摘要（证「服务端存的那份」和「客户端发的那份」一致） */
function verifyStored(path, byteLength, expectedHex) {
  if (byteLength <= MAX_INLINE_HASH_BYTES) {
    try {
      const bytes = $os.readFile(path);
      const hex = K.sha256Bytes(bytes);
      return { ok: hex === expectedHex, sha256: hex, method: 'js-readback' };
    } catch (e) { /* 落到命令行 */ }
  }
  const hashed = hashFile(path, byteLength);
  if (!hashed) return { ok: false, sha256: '', method: 'unavailable' };
  return { ok: hashed.sha256 === expectedHex, sha256: hashed.sha256, method: hashed.method };
}

/**
 * 证据上传：JSON + base64。
 *
 * 为什么不是 multipart：服务端运行时的 multipart 文件句柄取不到字节流，
 * 落盘会失败；base64 JSON 是字节精确的通道，还省掉一堆边界情况。
 * 摘要照旧是「客户端声明、服务端自算、不一致拒收」——
 * 收下来算一次，落盘后再读回来算一次，两次都要对得上。
 */
function upload(c) {
  return K.guard(c, () => {
    const info = K.reqInfo(c);
    K.assertContractVersion(info);
    const agent = A.requireAgent(info, 'ingest');
    const rate = RATE.check(agent);
    const body = K.bodyObject(c, info);

    const b64 = String(body.content_base64 || body.content || '');
    if (!b64) {
      throw K.fail(400, 'MISSING_FILE',
        'content_base64 必填：证据文件本体（base64），例如 fs.readFileSync(p).toString("base64")', {
        field: 'content_base64',
      });
    }
    const bytes = K.base64ToBytes(b64);
    if (!bytes.length) {
      throw K.fail(422, 'VALIDATION_FAILED', 'content_base64 解出来是空内容', { field: 'content_base64' });
    }
    if (bytes.length > MAX_UPLOAD_BYTES) {
      throw K.fail(413, 'EVIDENCE_TOO_LARGE',
        '单条证据上限 ' + Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024) + 'MB；大文件请截关键片段或分片存本地留 hash',
        { size: bytes.length, limit: MAX_UPLOAD_BYTES });
    }

    const digest = declaredDigest(info, body);
    if (!digest) {
      throw K.fail(400, 'DIGEST_REQUIRED',
        '上传必须带内容摘要（对立面的 sha-256，不是 HTTP body 的）：' +
        'Content-Digest: sha-256=:<BASE64>: 或 X-Content-SHA256: <hex> 或 body.sha256', {
        field: 'Content-Digest',
      });
    }

    const actual = K.sha256Bytes(bytes);
    if (actual !== digest.hex) {
      K.audit('evidence', 'digest_mismatch', {
        agent_name: agent.name, status: 400, code: 'DIGEST_MISMATCH',
        detail: 'declared=' + digest.hex + ' actual=' + actual,
      });
      throw K.fail(400, 'DIGEST_MISMATCH',
        '服务端自算 sha256 与声明不一致：内容被改动或截断，已拒收', {
        declared: digest.hex, actual: actual, declared_from: digest.from,
      });
    }

    // 内容寻址：同一份内容只有一个 evidence.id（天然幂等）
    let dup = null;
    try {
      dup = $app.findFirstRecordByFilter('evidence', 'sha256 = {:s}', { s: actual });
    } catch (e) { dup = null; }
    if (dup) {
      return K.ok(c, {
        evidence: evidenceJson(dup),
        deduplicated: true,
        digest_verified: !!dup.get('digest_verified'),
        rate_limit: rate,
      }, 200);
    }

    const kind = String(body.kind || K.qStr(info, 'kind') || '');
    const note = String(body.note || K.qStr(info, 'note') || '');
    const contentType = String(body.content_type || K.qStr(info, 'content_type') || 'application/octet-stream');
    const fileName = String(body.filename || (kind ? kind + '.bin' : 'evidence.bin'));

    const col = $app.findCollectionByNameOrId('evidence');
    const rec = new Record(col);
    try {
      rec.set('file', $filesystem.fileFromBytes(bytes, safeFileName(fileName)));
      rec.set('sha256', actual);
      rec.set('size', bytes.length);
      rec.set('content_type', contentType);
      rec.set('kind', kind);
      rec.set('note', note);
      rec.set('agent_name', agent.name);
      rec.set('original_name', fileName);
      rec.set('digest_verified', false);
      rec.set('hash_method', '');
      $app.save(rec);
    } catch (e) {
      throw K.fail(500, 'SAVE_FAILED', '证据落库失败', { detail: String(e).slice(0, 300) });
    }

    const stored = verifyStored(storedPath(rec), bytes.length, actual);
    rec.set('digest_verified', stored.ok);
    rec.set('hash_method', stored.method);
    try { $app.save(rec); } catch (e) { /* ignore */ }

    K.audit('evidence', 'upload', {
      agent_name: agent.name, item_id: rec.id, status: 201,
      detail: actual + ' (' + stored.method + ', readback=' + (stored.ok ? 'ok' : 'mismatch') + ')',
    });

    const warnings = [];
    if (!stored.ok) {
      warnings.push({
        code: 'STORED_DIGEST_MISMATCH',
        message: stored.method === 'unavailable'
          ? '本机没有可用的 sha256 工具，落盘后未能回读复核；内容摘要已按收下来的字节校验通过'
          : '落盘后回读的摘要与声明不一致（存储环节异常），已标记待人工核对',
        expected: actual, actual: stored.sha256, method: stored.method,
      });
    }

    return K.ok(c, {
      evidence: evidenceJson(rec),
      deduplicated: false,
      digest_verified: stored.ok,
      warnings: warnings,
      rate_limit: rate,
    }, 201);
  });
}

/* ───────────────────────── 元数据 / 下载 ───────────────────────── */

function meta(c) {
  return K.guard(c, () => {
    const info = K.reqInfo(c);
    K.assertContractVersion(info);
    const agent = A.requireAgent(info, null);
    RATE.check(agent);
    const id = String(c.request.pathValue('id') || '');
    let rec = null;
    try { rec = $app.findRecordById('evidence', id); } catch (e) { rec = null; }
    if (!rec) throw K.fail(404, 'EVIDENCE_NOT_FOUND', '证据不存在', { id: id });
    return K.ok(c, { evidence: evidenceJson(rec) });
  });
}

function download(c) {
  return K.guard(c, () => {
    const info = K.reqInfo(c);
    K.assertContractVersion(info);
    const agent = A.requireAgent(info, null);
    RATE.check(agent);
    const id = String(c.request.pathValue('id') || '');
    let rec = null;
    try { rec = $app.findRecordById('evidence', id); } catch (e) { rec = null; }
    if (!rec) throw K.fail(404, 'EVIDENCE_NOT_FOUND', '证据不存在', { id: id });

    const size = Number(rec.get('size') || 0);
    if (size > MAX_INLINE_DOWNLOAD_BYTES) {
      throw K.fail(413, 'EVIDENCE_TOO_LARGE',
        '证据体积超出内联下载上限，请用元数据里的 file_url 在控制台里查看', {
        size: size, limit: MAX_INLINE_DOWNLOAD_BYTES,
      });
    }
    const path = storedPath(rec);
    let bytes = null;
    try { bytes = $os.readFile(path); } catch (e) { bytes = null; }
    if (!bytes) {
      throw K.fail(404, 'FILE_MISSING', '证据记录在，但文件已不在存储里（可能被清理）', { id: id });
    }
    const actual = K.sha256Bytes(bytes);
    return K.ok(c, {
      evidence_id: id,
      content_base64: K.bytesToBase64(bytes),
      size: bytes.length,
      content_type: String(rec.get('content_type') || 'application/octet-stream'),
      sha256: actual,
      sha256_declared: String(rec.get('sha256') || ''),
      sha256_match: actual === String(rec.get('sha256') || ''),
      encoding: 'base64',
    });
  });
}

module.exports = {
  upload: upload,
  meta: meta,
  download: download,
  hashFile: hashFile,
  evidenceJson: evidenceJson,
};
