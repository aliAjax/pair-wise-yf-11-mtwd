// 路由模块：拓片、缺损、工价表、修补批次与结算闭环的HTTP编排
const { readDb, writeDb, makeId } = require("./storage");
const { send, parseBody, required, httpError } = require("./http");
const priceList = require("./priceList");
const settlement = require("./settlement");

const routes = [
  "GET /health",
  "GET /rubbings",
  "POST /rubbings",
  "GET /rubbings/:id/damages",
  "POST /rubbings/:id/damages",
  "GET /damages?status=&type=",
  "PATCH /damages/:id",
  "GET /price-list?active=",
  "POST /price-list",
  "GET /price-list/:id",
  "PATCH /price-list/:id",
  "GET /batches",
  "POST /batches",
  "GET /batches/:id",
  "POST /batches/:id/start",
  "POST /batches/:id/complete",
  "POST /batches/:id/cancel"
];

function findRubbing(db, rubbingId) {
  const rubbing = db.rubbings.find((item) => item.id === rubbingId);
  if (!rubbing) throw httpError(404, "拓片不存在");
  return rubbing;
}

function findBatch(db, id, message = "修补批次不存在") {
  const batch = db.batches.find((item) => item.id === id);
  if (!batch) throw httpError(404, message);
  return batch;
}

function enrichBatch(db, batch) {
  const damages = db.damages.filter((item) => batch.damageIds.includes(item.id));
  return {
    ...batch,
    damages,
    total: damages.length,
    repaired: damages.filter((item) => item.status === "repaired").length,
    pending: damages.filter((item) => item.status !== "repaired").length,
    estimatedFee: settlement.estimatedTotal(batch.pricing || []),
    fee: batch.settlement ? batch.settlement.totalFee : null
  };
}

async function handlePriceListRoutes(req, res, db, url, pathname) {
  if (req.method === "GET" && pathname === "/price-list") {
    send(res, 200, { data: priceList.listEntries(db, { active: url.searchParams.get("active") }) });
    return true;
  }

  if (req.method === "POST" && pathname === "/price-list") {
    const body = await parseBody(req);
    required(body, ["damageType", "category", "hourlyRate"]);
    const entry = priceList.createEntry(db, body);
    await writeDb(db);
    send(res, 201, { data: entry });
    return true;
  }

  const entryMatch = pathname.match(/^\/price-list\/([^/]+)$/);
  if (entryMatch && req.method === "GET") {
    send(res, 200, { data: priceList.getEntry(db, entryMatch[1]) });
    return true;
  }
  if (entryMatch && req.method === "PATCH") {
    const body = await parseBody(req);
    const entry = priceList.updateEntry(db, entryMatch[1], body);
    await writeDb(db);
    send(res, 200, { data: entry });
    return true;
  }

  return false;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "rubbing-repair-api", routes });
  }

  if (req.method === "GET" && pathname === "/rubbings") {
    const data = db.rubbings.map((rubbing) => {
      const damages = db.damages.filter((item) => item.rubbingId === rubbing.id);
      return {
        ...rubbing,
        damageCount: damages.length,
        pendingDamages: damages.filter((item) => item.status !== "repaired").length
      };
    });
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/rubbings") {
    const body = await parseBody(req);
    required(body, ["code", "source", "paperSize"]);
    const rubbing = {
      id: makeId("rubbing"),
      code: body.code,
      source: body.source,
      paperSize: body.paperSize,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.rubbings.push(rubbing);
    await writeDb(db);
    return send(res, 201, { data: rubbing });
  }

  const rubbingDamagesMatch = pathname.match(/^\/rubbings\/([^/]+)\/damages$/);
  if (rubbingDamagesMatch && req.method === "GET") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    return send(res, 200, { data: db.damages.filter((item) => item.rubbingId === rubbingId) });
  }

  if (rubbingDamagesMatch && req.method === "POST") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    const body = await parseBody(req);
    required(body, ["position", "type", "beforePhotoUrl"]);
    const damage = {
      id: makeId("damage"),
      rubbingId,
      position: body.position,
      type: body.type,
      beforePhotoUrl: body.beforePhotoUrl,
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      startedAt: null,
      createdAt: new Date().toISOString(),
      repairedAt: null
    };
    db.damages.push(damage);
    await writeDb(db);
    return send(res, 201, { data: damage });
  }

  if (req.method === "GET" && pathname === "/damages") {
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const data = db.damages.filter((item) => (!status || item.status === status) && (!type || item.type === type));
    return send(res, 200, { data });
  }

  const damagePatchMatch = pathname.match(/^\/damages\/([^/]+)$/);
  if (damagePatchMatch && req.method === "PATCH") {
    const damage = db.damages.find((item) => item.id === damagePatchMatch[1]);
    if (!damage) return send(res, 404, { error: "缺损项不存在" });
    const body = await parseBody(req);
    Object.assign(damage, {
      position: body.position ?? damage.position,
      type: body.type ?? damage.type,
      beforePhotoUrl: body.beforePhotoUrl ?? damage.beforePhotoUrl,
      afterPhotoUrl: body.afterPhotoUrl ?? damage.afterPhotoUrl,
      status: body.status ?? damage.status,
      repairNote: body.repairNote ?? damage.repairNote
    });
    damage.repairedAt = damage.status === "repaired" ? new Date().toISOString() : damage.repairedAt;
    await writeDb(db);
    return send(res, 200, { data: damage });
  }

  if (await handlePriceListRoutes(req, res, db, url, pathname)) return;

  if (req.method === "GET" && pathname === "/batches") {
    return send(res, 200, { data: db.batches.map((batch) => enrichBatch(db, batch)) });
  }

  if (req.method === "POST" && pathname === "/batches") {
    const body = await parseBody(req);
    required(body, ["name", "damageIds"]);
    if (!Array.isArray(body.damageIds) || body.damageIds.length === 0) {
      return send(res, 400, { error: "damageIds必须是非空数组" });
    }
    const damageIds = [...new Set(body.damageIds)];
    const invalid = damageIds.filter((id) => !db.damages.find((damage) => damage.id === id));
    if (invalid.length) return send(res, 400, { error: `缺损项不存在：${invalid.join(", ")}` });

    const inOpenBatch = damageIds.filter((id) => {
      const damage = db.damages.find((item) => item.id === id);
      const owner = db.batches.find((batch) => batch.id === damage.batchId && batch.status === "open");
      return Boolean(owner);
    });
    if (inOpenBatch.length) return send(res, 400, { error: `缺损项已在其他开放批次中：${inOpenBatch.join(", ")}` });

    const pickedDamages = damageIds.map((id) => db.damages.find((item) => item.id === id));
    const overrides = body.estimatedHours && typeof body.estimatedHours === "object" ? body.estimatedHours : {};

    // 建批即按缺损类型登记计价类别与预估工时（单价快照）
    const pricing = settlement.registerPricing(db, pickedDamages, overrides);

    const batch = {
      id: makeId("batch"),
      name: body.name,
      status: "open",
      damageIds,
      pricing,
      settlement: null,
      note: body.note || "",
      createdAt: new Date().toISOString(),
      completedAt: null,
      cancelledAt: null
    };
    db.batches.push(batch);
    db.damages.forEach((damage) => {
      if (damageIds.includes(damage.id)) damage.batchId = batch.id;
    });
    await writeDb(db);
    return send(res, 201, { data: enrichBatch(db, batch) });
  }

  const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
  if (batchMatch && req.method === "GET") {
    const batch = findBatch(db, batchMatch[1]);
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  const startMatch = pathname.match(/^\/batches\/([^/]+)\/start$/);
  if (startMatch && req.method === "POST") {
    const batch = findBatch(db, startMatch[1]);
    if (batch.status !== "open") throw httpError(409, `批次已${batch.status === "completed" ? "结项" : "取消"}，不能再登记开工`);

    const body = await parseBody(req);
    const targetIds = Array.isArray(body.damageIds) && body.damageIds.length ? [...new Set(body.damageIds)] : batch.damageIds;
    const unknown = targetIds.filter((id) => !batch.damageIds.includes(id));
    if (unknown.length) return send(res, 400, { error: `缺损项不属于该批次：${unknown.join(", ")}` });

    const nowIso = new Date().toISOString();
    batch.pricing.forEach((item) => {
      if (targetIds.includes(item.damageId)) item.started = true;
    });
    db.damages.forEach((damage) => {
      if (targetIds.includes(damage.id)) {
        damage.status = "in_repair";
        if (!damage.startedAt) damage.startedAt = nowIso;
      }
    });
    await writeDb(db);
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  const completeMatch = pathname.match(/^\/batches\/([^/]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    const batch = findBatch(db, completeMatch[1]);

    // 费用冻结：结项后重复结算直接返回第一次结果
    if (batch.status === "completed") return send(res, 200, { data: enrichBatch(db, batch), frozen: true });
    if (batch.status === "cancelled") throw httpError(409, "批次已取消，不能结项");

    const body = await parseBody(req);
    const results = Array.isArray(body.results) ? body.results : [];

    const actualHoursMap = {};
    for (const item of batch.pricing) {
      const result = results.find((entry) => entry.damageId === item.damageId);
      const actualHours = result ? result.actualHours : undefined;
      if (typeof actualHours !== "number" || !Number.isFinite(actualHours) || actualHours < 0) {
        return send(res, 400, { error: `缺损项「${item.damageId}」缺少合法的actualHours（非负数字）` });
      }
      actualHoursMap[item.damageId] = actualHours;
    }

    // 超预估两成且审批原因没写清：整批409，批次、费用与缺损状态均不变（校验在任何落库之前）
    settlement.assertCompletionAllowed(batch.pricing, actualHoursMap, body.approvalReason);

    const nowIso = new Date().toISOString();
    batch.status = "completed";
    batch.completedAt = nowIso;
    batch.note = body.note ?? batch.note;
    batch.pricing.forEach((item) => {
      item.started = true;
    });
    db.damages.forEach((damage) => {
      if (!batch.damageIds.includes(damage.id)) return;
      const result = results.find((item) => item.damageId === damage.id) || {};
      damage.status = "repaired";
      if (!damage.startedAt) damage.startedAt = nowIso;
      damage.afterPhotoUrl = result.afterPhotoUrl || body.defaultAfterPhotoUrl || damage.afterPhotoUrl;
      damage.repairNote = result.repairNote || body.defaultRepairNote || damage.repairNote;
      damage.repairedAt = nowIso;
    });
    batch.settlement = settlement.settleCompletion(batch.pricing, actualHoursMap, {
      approvalReason: body.approvalReason,
      note: body.note
    });
    await writeDb(db);
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  const cancelMatch = pathname.match(/^\/batches\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === "POST") {
    const batch = findBatch(db, cancelMatch[1]);

    // 费用冻结：取消后重复结算返回第一次结果
    if (batch.status === "cancelled") return send(res, 200, { data: enrichBatch(db, batch), frozen: true });
    if (batch.status === "completed") throw httpError(409, "批次已结项，费用已冻结，不能取消");

    const body = await parseBody(req);
    const actualHoursMap = body.actualHours && typeof body.actualHours === "object" ? body.actualHours : {};
    for (const item of batch.pricing) {
      if (!item.started) continue;
      const value = actualHoursMap[item.damageId];
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
        return send(res, 400, { error: `缺损项「${item.damageId}」的actualHours必须是非负数字` });
      }
    }

    batch.status = "cancelled";
    batch.cancelledAt = new Date().toISOString();
    db.damages.forEach((damage) => {
      if (!batch.damageIds.includes(damage.id)) return;
      const item = batch.pricing.find((entry) => entry.damageId === damage.id);
      damage.batchId = null;
      if (item && item.started) {
        // 已开工：保留在修状态，按实际工时结算后可另行组批
        damage.status = "in_repair";
      } else {
        // 没开始：不计费，释放回待修
        damage.status = "pending";
        damage.startedAt = null;
      }
    });
    batch.settlement = settlement.settleCancellation(batch.pricing, actualHoursMap, { reason: body.reason });
    await writeDb(db);
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

module.exports = { handle, routes };
