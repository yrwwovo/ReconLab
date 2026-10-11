/**
 * ReconLab 契约层 · 判定准则表（decision rubric）
 *
 * 解决的问题：「打过去没反应」到底算 rejected 还是 inconclusive？
 * 不在散文里扯，做成结构化规则：每个 kind 的 confirmed / rejected / inconclusive
 * 门槛都写成可读可编辑的字段。两边（ReconLab 与 PhantomVeil 插件）共用同一张表。
 *
 * enforce = true 的规则在 API 层硬拦（422 RUBRIC_VIOLATION）；
 * enforce = false 的只回 warning，不挡写入。
 */

const K = require('./kit.js');

const DEFAULT_KIND = 'default';

function allRubrics() {
  try {
    return $app.findRecordsByFilter('decision_rubrics', 'enabled = true', 'rule_id', 200, 0);
  } catch (e) {
    return [];
  }
}

function getRubric(kind) {
  const k = String(kind || '').trim();
  if (!k) return null;
  try {
    return $app.findFirstRecordByFilter('decision_rubrics', 'rule_id = {:r} && enabled = true', { r: k });
  } catch (e) {
    return null;
  }
}

function arr(record, field) {
  return K.asArray(record.get(field));
}

function rubricJson(record) {
  if (!record) return null;
  return {
    kind: String(record.get('rule_id') || ''),
    title: String(record.get('title') || ''),
    category: String(record.get('category') || ''),
    enforce: !!record.get('enforce'),
    min_confidence: Number(record.get('min_confidence') || 0),
    confirm_checks: arr(record, 'confirm_checks'),
    confirm_evidence_kinds: arr(record, 'confirm_evidence_kinds'),
    reject_reasons: arr(record, 'reject_reasons'),
    inconclusive_triggers: arr(record, 'inconclusive_triggers'),
    note: String(record.get('note') || ''),
  };
}

function checkState(payload, id) {
  const checks = Object.prototype.toString.call(payload.checks) === '[object Array]' ? payload.checks : [];
  for (let i = 0; i < checks.length; i++) {
    const c = checks[i];
    if (!c) continue;
    const cid = typeof c === 'string' ? c : String(c.id || c.check || '');
    if (cid === id) return typeof c === 'string' ? 'pass' : String(c.state || c.result || '');
  }
  return null;
}

/**
 * 按判定准则校验一次回写。
 * payload: {reproduction_steps, evidenceRefs, confidence, checks, verdict_note, curl,
 *           raw_request, raw_response, reason_code}
 * 返回 {errors: [...], warnings: [...], rubric}
 */
function checkVerdict(kind, extState, payload) {
  const record = getRubric(kind) || getRubric(DEFAULT_KIND);
  const rubric = rubricJson(record);
  const errors = [];
  const warnings = [];
  if (!rubric) return { errors: errors, warnings: warnings, rubric: null };

  const enforce = !!rubric.enforce;
  const push = (list, code, message, extra) => {
    list.push({ code: code, message: message, rubric: rubric.kind, data: extra || {} });
  };

  const steps = Object.prototype.toString.call(payload.reproduction_steps) === '[object Array]'
    ? payload.reproduction_steps : [];
  const evidence = Object.prototype.toString.call(payload.evidenceRefs) === '[object Array]'
    ? payload.evidenceRefs : [];
  const confidence = Number(payload.confidence || 0);
  const note = String(payload.verdict_note || '').trim();

  if (extState === 'confirmed') {
    if (!steps.length) {
      push(enforce ? errors : warnings, 'RUBRIC_MISSING_STEPS',
        'confirmed 必须带复现步骤（reproduction_steps）', { rubric: rubric.kind });
    }
    if (!evidence.length) {
      push(enforce ? errors : warnings, 'RUBRIC_MISSING_EVIDENCE',
        'confirmed 必须至少挂一条证据（evidence[].id 用 /api/evidence 拿到）');
    }
    if (rubric.min_confidence && confidence < rubric.min_confidence) {
      push(enforce ? errors : warnings, 'RUBRIC_LOW_CONFIDENCE',
        'confidence ' + confidence + ' 低于 ' + rubric.kind + ' 的判定门槛 ' + rubric.min_confidence,
        { min_confidence: rubric.min_confidence, confidence: confidence });
    }
    if (!note) {
      push(warnings, 'RUBRIC_MISSING_NOTE', '建议补 verdict_note：判定理由要能被人复核');
    }
    for (let i = 0; i < rubric.confirm_checks.length; i++) {
      const id = String(rubric.confirm_checks[i]);
      const st = checkState(payload, id);
      if (st === null) {
        push(warnings, 'RUBRIC_CHECK_MISSING', '未提交检查项「' + id + '」的状态');
      } else if (st !== 'pass') {
        push(enforce && id !== 'cross' ? errors : warnings, 'RUBRIC_CHECK_FAILED',
          '检查项「' + id + '」当前是 ' + st + '，未通过', { check: id, state: st });
      }
    }
    if (rubric.confirm_evidence_kinds.length && evidence.length) {
      const kinds = evidence.map((e) => String((e && e.kind) || ''));
      const ok = kinds.some((kk) => rubric.confirm_evidence_kinds.indexOf(kk) >= 0);
      if (!ok) {
        push(warnings, 'RUBRIC_EVIDENCE_KIND',
          '证据类型建议落在 ' + rubric.confirm_evidence_kinds.join('/') + '（当前：' + kinds.join('/') + '）');
      }
    }
  }

  if (extState === 'rejected') {
    if (!note) {
      push(enforce ? errors : warnings, 'RUBRIC_MISSING_NOTE',
        'rejected 必须写 verdict_note：说清否定依据（被编码/不可达/对照组同样跳转…）');
    }
    if (!evidence.length) {
      push(warnings, 'RUBRIC_NO_COUNTER_EVIDENCE',
        '建议给一条对照证据：rejected 也应该有请求响应留痕，不然复核时说不清');
    }
    const reason = String(payload.reason_code || '').trim();
    if (reason && rubric.reject_reasons.length && rubric.reject_reasons.indexOf(reason) < 0) {
      push(warnings, 'RUBRIC_UNKNOWN_REASON',
        '否定原因 ' + reason + ' 不在 ' + rubric.kind + ' 的既定原因表内：' + rubric.reject_reasons.join('/'),
        { allowed: rubric.reject_reasons });
    }
    if (!reason) {
      push(warnings, 'RUBRIC_REASON_CODE_MISSING',
        '建议带 reason_code，可选值：' + rubric.reject_reasons.join('/'));
    }
  }

  if (extState === 'inconclusive') {
    if (!note) {
      push(warnings, 'RUBRIC_MISSING_NOTE', 'inconclusive 请写 verdict_note：说明卡在哪（超时/被 WAF 挡/未投递）');
    }
    const trigger = String(payload.reason_code || '').trim();
    if (trigger && rubric.inconclusive_triggers.length && rubric.inconclusive_triggers.indexOf(trigger) < 0) {
      push(warnings, 'RUBRIC_UNKNOWN_TRIGGER',
        '触发原因 ' + trigger + ' 不在既定表内：' + rubric.inconclusive_triggers.join('/'));
    }
  }

  return { errors: errors, warnings: warnings, rubric: rubric };
}

/** 判据文本（写进判定理由，方便人工复核时一眼看到门槛） */
function rubricSummary(kind) {
  const rubric = rubricJson(getRubric(kind) || getRubric(DEFAULT_KIND));
  return rubric ? rubric.note : '';
}

module.exports = {
  DEFAULT_KIND: DEFAULT_KIND,
  allRubrics: allRubrics,
  getRubric: getRubric,
  rubricJson: rubricJson,
  checkVerdict: checkVerdict,
  rubricSummary: rubricSummary,
};
