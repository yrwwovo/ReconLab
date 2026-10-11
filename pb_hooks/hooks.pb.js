/**
 * ReconLab 契约层 · 数据钩子
 *
 * 1. review_queue 的实体版本 rev：内容变了才推进（租约/心跳不动它）
 * 2. 定期清理幂等键与限流桶，别让辅助表无限长
 */

/**
 * 注意：本版 JSVM 里 `onRecordCreate("集合名", fn)` 这种「首个参数传集合名」的写法
 * **不会触发**（集合名会被当成 hook tag，钩子静默不生效 → rev 永远停在 1、etag 永远不变，
 * If-Match 乐观锁就形同虚设）。所以统一用「不带集合名的注册 + 自己判集合」的写法。
 * 实测（0.23.4）：带集合名注册 0 次触发，不带则正常触发。
 */
/**
 * 另外：钩子回调里**引用不到本文件的顶层变量/函数**（和路由 handler 一样的坑），
 * 所以判断逻辑必须整个写进回调里，别抽公共函数出去 —— 抽了会在运行时抛错，
 * 表现是「任何集合建记录都 400 Failed to create record」，极难查。
 */

/**
 * 还有第三个坑：回调**必须走到 e.next()**，中途直接 return 会让这次写入静默失败
 * （表现：接口返回 200，记录却没落库；再查就是 404，Agent 拿 key 也过不了鉴权）。
 * 所以一律「try 包住自己的逻辑 → 无论成败都 e.next()」。
 */

onRecordCreate((e) => {
  try {
    if (String(e.record.collection().name) === "review_queue") {
      require(__hooks + "/lib/rev.js").onCreate(e.record);
    }
  } catch (err) {
    // 版本维护不能反过来阻断写入：记一笔就好
    try { console.log("[reconlab] rev.onCreate 失败: " + err); } catch (e2) { /* ignore */ }
  }
  e.next();
});

onRecordUpdate((e) => {
  try {
    if (String(e.record.collection().name) === "review_queue") {
      require(__hooks + "/lib/rev.js").onUpdate(e.record);
    }
  } catch (err) {
    try { console.log("[reconlab] rev.onUpdate 失败: " + err); } catch (e2) { /* ignore */ }
  }
  e.next();
});

cronAdd("reconlab_idempotency_cleanup", "17 3 * * *", () => {
  try { require(__hooks + "/lib/idem.js").cleanup(); } catch (e) { /* ignore */ }
});

cronAdd("reconlab_rate_bucket_cleanup", "7 * * * *", () => {
  try { require(__hooks + "/lib/rate.js").cleanup(6); } catch (e) { /* ignore */ }
});
