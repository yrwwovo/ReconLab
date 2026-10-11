/**
 * ReconLab 契约层 · Agent 鉴权
 *
 *   Agent 用独立 API Key（rlk_ 开头），不走账号密码登录。
 *   库里只存 sha256(key)，明文只在生成那一刻出现过。
 *   权限由 agents.scopes 决定：ingest（上报发现）/ review（拉队列 + 回写判定）。
 *
 *   agent_name 一律从 key 反推，忽略客户端自填 —— 审计才可信。
 */

const K = require('./kit.js');

const AGENT_KEY_PREFIX = 'rlk_';

function sha256Hex(s) {
  return String($security.sha256(String(s)));
}

function agentName(agent) {
  return String(agent.get('name') || agent.id);
}

function agentScopes(agent) {
  const raw = String(agent.get('scopes') || agent.get('mode') || '').toLowerCase();
  const out = [];
  if (raw.indexOf('ingest') >= 0) out.push('ingest');
  if (raw.indexOf('review') >= 0) out.push('review');
  if (raw.indexOf('both') >= 0) { out.push('ingest'); out.push('review'); }
  if (raw.indexOf('scan') >= 0) out.push('scan');
  return out;
}

function findByKey(key) {
  const hash = sha256Hex(key);
  return $app.findFirstRecordByFilter('agents', 'api_key_hash = {:h}', { h: hash });
}

function touch(agent) {
  try {
    const last = agent.get('key_last_used');
    const now = new Date();
    if (last) {
      const d = new Date(String(last).replace(' ', 'T'));
      if (!isNaN(d.getTime()) && now.getTime() - d.getTime() < 60000) return;
    }
    agent.set('key_last_used', now.toISOString());
    agent.set('last_seen', now.toISOString());
    if (String(agent.get('status') || '') !== 'revoked') agent.set('status', 'online');
    $app.save(agent);
  } catch (e) { /* 心跳式更新失败不影响主流程 */ }
}

/**
 * 校验 Bearer key 并检查权限。
 * need: 'ingest' | 'review' | null（只要求是合法 Agent）
 */
function requireAgent(info, need) {
  const auth = K.header(info, 'authorization');
  if (!auth) {
    throw K.fail(401, 'UNAUTHORIZED', '缺少 Authorization: Bearer <agent-key>');
  }
  if (auth.toLowerCase().indexOf('bearer ') !== 0) {
    throw K.fail(401, 'UNAUTHORIZED', 'Authorization 必须是 Bearer 形式');
  }
  const key = auth.slice(7).trim();
  if (key.indexOf(AGENT_KEY_PREFIX) !== 0) {
    throw K.fail(401, 'AGENT_KEY_INVALID',
      'Agent 必须用契约专用 API Key（' + AGENT_KEY_PREFIX + '…）；控制台账号密码登录不属于契约通道', {
        hint: '在 /agent 页面创建 Agent 身份并生成 Key',
      });
  }
  let agent = null;
  try {
    agent = findByKey(key);
  } catch (e) {
    agent = null;
  }
  if (!agent) {
    throw K.fail(401, 'AGENT_KEY_INVALID', 'API Key 无效或已被轮换');
  }
  const status = String(agent.get('status') || '');
  if (status === 'revoked') {
    throw K.fail(401, 'AGENT_DISABLED', 'Agent 已被停用');
  }
  const scopes = agentScopes(agent);
  if (need && scopes.indexOf(need) < 0) {
    throw K.fail(403, 'PERMISSION_DENIED',
      '当前 Key 没有 ' + need + ' 权限（现有：' + (scopes.join(',') || '无') + '）', {
      required: need, granted: scopes,
    });
  }
  touch(agent);
  return {
    record: agent,
    id: agent.id,
    name: agentName(agent),
    scopes: scopes,
  };
}

/** 生成一个新的 Agent Key（由控制台调用，用于创建身份时发号） */
function generateKey() {
  const body = String($security.randomStringWithAlphabet(48, 'abcdef0123456789'));
  return AGENT_KEY_PREFIX + body;
}

function keyPrefix(key) {
  return String(key).slice(0, AGENT_KEY_PREFIX.length + 12);
}

module.exports = {
  AGENT_KEY_PREFIX: AGENT_KEY_PREFIX,
  sha256Hex: sha256Hex,
  requireAgent: requireAgent,
  generateKey: generateKey,
  keyPrefix: keyPrefix,
  agentScopes: agentScopes,
  agentName: agentName,
};
