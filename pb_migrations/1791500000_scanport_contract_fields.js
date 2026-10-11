/// <reference path="../pb_data/types.d.ts" />
/**
 * ScanPort 契约 · 给 scans / findings 补上扫描后端接口需要的字段。
 *   scans:    scope_id(预算按它计量)、failure_code(failed 态稳定码)、idem_key(审计用)
 *   findings: service / version / fingerprint / cve_candidates / evidence_refs
 *             —— 结构化到 服务/版本/指纹/CVE候选 + 证据引用，直接喂 PhantomVeil 深度验证。
 */
migrate((app) => {
  const scans = app.findCollectionByNameOrId('scans');
  scans.fields.add(new Field({ type: 'text', name: 'scope_id', max: 40, min: 0 }));
  scans.fields.add(new Field({ type: 'text', name: 'failure_code', max: 60, min: 0 }));
  scans.fields.add(new Field({ type: 'text', name: 'idem_key', max: 200, min: 0 }));
  scans.fields.add(new Field({ type: 'text', name: 'target_value', max: 2048, min: 0 }));
  app.save(scans);

  const findings = app.findCollectionByNameOrId('findings');
  findings.fields.add(new Field({ type: 'text', name: 'service', max: 200, min: 0 }));
  findings.fields.add(new Field({ type: 'text', name: 'version', max: 100, min: 0 }));
  findings.fields.add(new Field({ type: 'text', name: 'fingerprint', max: 400, min: 0 }));
  findings.fields.add(new Field({ type: 'json', name: 'cve_candidates', maxSize: 20000 }));
  findings.fields.add(new Field({ type: 'json', name: 'evidence_refs', maxSize: 20000 }));
  app.save(findings);
}, (app) => {
  const drop = (collName, names) => {
    const col = app.findCollectionByNameOrId(collName);
    for (let i = 0; i < names.length; i++) {
      try { col.fields.removeByName(names[i]); } catch (e) { /* ignore */ }
    }
    app.save(col);
  };
  drop('scans', ['scope_id', 'failure_code', 'idem_key', 'target_value']);
  drop('findings', ['service', 'version', 'fingerprint', 'cve_candidates', 'evidence_refs']);
});
