/**
 * ReconLab 契约层 · 状态映射层
 *
 *   对外（PhantomVeil 只认这 5 个）:
 *     suspected / testing / confirmed / rejected / inconclusive
 *   内部（站内复核机保留原样，8 态 + 人工签字位）:
 *     new / normalized / awaiting_human / auto_verified / confirmed / rejected / uncertain / retest
 *
 * 映射规则（拍板结论：对外当视图、内部保留、中间加映射层）:
 *   new / normalized            → suspected        （待验证，可被领取）
 *   new / normalized / retest   → testing          （被租约领走时）
 *   retest                      → suspected        （退回重新入队）
 *   awaiting_human              → testing          （自动证伪跑完，等人工判定 —— Agent 不可见）
 *   auto_verified               → 按 verdict 收敛：confirmed→confirmed / false_positive→rejected
 *                                                   uncertain→inconclusive / need_retest→suspected
 *   uncertain                   → inconclusive
 *   confirmed / rejected        → 同名
 *
 * 关键点：Agent 回写一律落到内部 auto_verified（= 平台复核位仍在），
 * 所以「报告主文只出人工签字过的 confirmed」这个假阳性卖点一点没丢。
 */

const K = require('./kit.js');

function leaseActive(record, at) {
  const token = record.get('lease_token');
  const exp = record.get('lease_expires_at');
  if (!token || !exp) return false;
  const d = new Date(String(exp).replace(' ', 'T'));
  if (isNaN(d.getTime())) return false;
  return d.getTime() > (at || new Date()).getTime();
}

function leaseJson(record, at) {
  const active = leaseActive(record, at);
  return {
    active: active,
    holder: active ? String(record.get('claimed_by') || '') : '',
    expires_at: active ? K.isoOf(record.get('lease_expires_at')) : null,
  };
}

/** 内部状态 + 租约 → 对外状态 */
function externalOf(record, at) {
  const internal = String(record.get('state') || '');
  const leased = leaseActive(record, at);
  switch (internal) {
    case 'new':
    case 'normalized':
    case 'retest':
      return leased ? 'testing' : 'suspected';
    case 'awaiting_human':
      return 'testing';
    case 'auto_verified': {
      const v = String(record.get('verdict') || '');
      return K.VERDICT_TO_EXTERNAL[v] || 'testing';
    }
    case 'uncertain':
      return 'inconclusive';
    case 'confirmed':
      return 'confirmed';
    case 'rejected':
      return 'rejected';
    default:
      return 'suspected';
  }
}

/** 对外状态是不是终态（终态不可原地回退，要重开必须走 supersedes） */
function isTerminalExternal(state) {
  return state === 'confirmed' || state === 'rejected';
}

function canTransition(from, to) {
  const list = K.TRANSITIONS[from];
  if (!list) return false;
  return list.indexOf(to) >= 0;
}

/** 人工签过字的终态：只有重开路径能推翻 */
function isHumanTerminal(internal) {
  return internal === 'confirmed' || internal === 'rejected';
}

/**
 * Agent 判定可写入的迁移规则（契约层自己的一套，不改站内复核机的表）。
 * 关键点：Agent 领一条刚入库的记录（new）直接回写判定是主路径，
 * 站内的 new→auto_verified 必须放行；人工签过字的终态则只能走 supersedes 重开。
 */
const AGENT_VERDICT_FROM = ['new', 'normalized', 'awaiting_human', 'auto_verified', 'uncertain', 'retest'];
const AGENT_RETEST_FROM = ['new', 'normalized', 'retest', 'awaiting_human', 'auto_verified', 'uncertain'];

function agentCanWrite(current, targetInternal) {
  if (targetInternal === 'auto_verified') return AGENT_VERDICT_FROM.indexOf(current) >= 0;
  if (targetInternal === 'retest') return AGENT_RETEST_FROM.indexOf(current) >= 0;
  return canTransition(current, targetInternal);
}

/**
 * 把 Agent 写来的对外状态翻译成内部状态。
 * 返回 {state, verdict, reason}
 */
function internalForExternal(extState, payload) {
  const ext = String(extState || '').trim();
  if (K.EXTERNAL_STATES.indexOf(ext) < 0) {
    return { error: 'INVALID_STATE', message: '非法状态；对外只接受 ' + K.EXTERNAL_STATES.join(' / ') };
  }
  switch (ext) {
    case 'testing':
      return { state: null, verdict: null, reason: 'progress_only' }; // 不改造内部状态，只表示「我在验」
    case 'confirmed':
      return { state: 'auto_verified', verdict: 'confirmed' };
    case 'rejected':
      return { state: 'auto_verified', verdict: 'false_positive' };
    case 'inconclusive':
      return { state: 'auto_verified', verdict: 'uncertain' };
    case 'suspected':
      return { state: 'retest', verdict: 'need_retest' };
    default:
      return { error: 'INVALID_STATE', message: '非法状态' };
  }
}

/** 人工复核签字走到哪一步了（信息性字段，不泄露内部状态机） */
function reviewStatus(record) {
  const s = String(record.get('state') || '');
  if (s === 'new' || s === 'normalized') return 'not_started';
  if (s === 'awaiting_human' || s === 'auto_verified' || s === 'uncertain' || s === 'retest') return 'pending_platform_review';
  if (s === 'confirmed' || s === 'rejected') return 'signed_off';
  return 'unknown';
}

module.exports = {
  leaseActive: leaseActive,
  leaseJson: leaseJson,
  externalOf: externalOf,
  isTerminalExternal: isTerminalExternal,
  canTransition: canTransition,
  isHumanTerminal: isHumanTerminal,
  agentCanWrite: agentCanWrite,
  internalForExternal: internalForExternal,
  reviewStatus: reviewStatus,
};
