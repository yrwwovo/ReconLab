/**
 * ReconLab 契约层 · 路由表
 *
 * JSVM 的 handler 不共享文件顶层作用域，所以每个 handler 都要自己 require 一次。
 * 这里只做注册，别写逻辑 —— 逻辑都在 pb_hooks/routes/*.js 与 pb_hooks/lib/*.js。
 *
 * 注意：同一个 method + path 重复注册会让进程 panic，路由表只能注册一次。
 */

/* ─── 验证队列 ─── */
routerAdd("GET", "/api/verification/queue", (c) => require(__hooks + "/routes/queue.js").list(c));
routerAdd("POST", "/api/verification/queue", (c) => require(__hooks + "/routes/queue.js").create(c));
routerAdd("GET", "/api/verification/queue/{id}", (c) => require(__hooks + "/routes/queue.js").getOne(c));
routerAdd("PATCH", "/api/verification/queue/{id}", (c) => require(__hooks + "/routes/queue.js").patch(c));
routerAdd("POST", "/api/verification/queue/{id}/claim", (c) => require(__hooks + "/routes/queue.js").claim(c));
routerAdd("POST", "/api/verification/queue/{id}/heartbeat", (c) => require(__hooks + "/routes/queue.js").heartbeat(c));
routerAdd("POST", "/api/verification/queue/{id}/release", (c) => require(__hooks + "/routes/queue.js").release(c));

/* --- 扫描工具后端 (ScanPort) --- */
routerAdd("POST", "/api/scans", (c) => require(__hooks + "/routes/scans.js").create(c));
routerAdd("GET", "/api/scans/{id}", (c) => require(__hooks + "/routes/scans.js").getOne(c));
routerAdd("GET", "/api/scans/{id}/findings", (c) => require(__hooks + "/routes/scans.js").findings(c));

/* ─── 证据通道 ─── */
routerAdd("POST", "/api/evidence", (c) => require(__hooks + "/routes/evidence.js").upload(c));
routerAdd("GET", "/api/evidence/{id}", (c) => require(__hooks + "/routes/evidence.js").meta(c));
routerAdd("GET", "/api/evidence/{id}/raw", (c) => require(__hooks + "/routes/evidence.js").download(c));

/* ─── 授权范围 ─── */
routerAdd("GET", "/api/scopes", (c) => require(__hooks + "/routes/scopes.js").list(c));
routerAdd("GET", "/api/scopes/{id}", (c) => require(__hooks + "/routes/scopes.js").get(c));
routerAdd("POST", "/api/scope/check", (c) => require(__hooks + "/routes/scopes.js").check(c));

/* ─── 判定准则 + 契约自描述 ─── */
routerAdd("GET", "/api/rubrics", (c) => require(__hooks + "/routes/meta.js").list(c));
routerAdd("GET", "/api/rubrics/{kind}", (c) => require(__hooks + "/routes/meta.js").get(c));
routerAdd("GET", "/api/contract/meta", (c) => require(__hooks + "/routes/meta.js").meta(c));
