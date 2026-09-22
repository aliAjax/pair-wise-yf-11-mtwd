// 路由模块：HTTP 入口，负责解析请求、调用工价表/结算规则、返回响应
// 现有接口的响应结构保持不变，新字段（items / settlement / rate 相关）均为追加。

const {
  defaultRateTable,
  validateRateInput,
  findActiveRate,
  resolveItems
} = require("./pricing");
const { settleCompletion, settleCancellation } = require("./settlement");

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function registerRoutes({ app, readDb, writeDb, routes }) {
  const findRubbing = (db, rubbingId) => {
    const rubbing = db.rubbings.find((item) => item.id === rubbingId);
    if (!rubbing) {
      const error = new Error("拓片不存在");
      error.status = 404;
      throw error;
    }
    return rubbing;
  };

  const enrichBatch = (db, batch) => {
    const damages = db.damages.filter((item) => batch.damageIds.includes(item.id));
    return {
      ...batch,
      damages,
      total: damages.length,
      repaired: damages.filter((item) => item.status === "repaired").length,
      pending: damages.filter((item) => item.status !== "repaired").length
    };
  };

  // ---- 工价表 ----
  app.route("GET", /^\/rates$/, async (req, res, _match, { url }) => {
    const db = await readDb();
    const activeOnly = url.searchParams.get("active") === "true";
    const type = url.searchParams.get("type");
    let data = db.rates;
    if (activeOnly) data = data.filter((rate) => rate.active);
    if (type) data = data.filter((rate) => rate.type === type);
    send(res, 200, { data });
  });

  app.route("POST", /^\/rates$/, async (req, res) => {
    const body = await parseBody(req);
    const rate = validateRateInput(body);
    const db = await readDb();
    const idx = db.rates.findIndex((item) => item.type === rate.type);
    if (idx >= 0) {
      db.rates[idx] = { ...db.rates[idx], ...rate };
    } else {
      db.rates.push(rate);
    }
    await writeDb(db);
    send(res, idx >= 0 ? 200 : 201, { data: idx >= 0 ? db.rates[idx] : rate });
  });

  app.route("PATCH", /^\/rates\/([^/]+)$/, async (req, res, match) => {
    const type = decodeURIComponent(match[1]);
    const body = await parseBody(req);
    const db = await readDb();
    const rate = db.rates.find((item) => item.type === type);
    if (!rate) return send(res, 404, { error: "工价不存在" });
    const merged = validateRateInput({ ...rate, ...body, type });
    Object.assign(rate, merged);
    await writeDb(db);
    send(res, 200, { data: rate });
  });

  app.route("DELETE", /^\/rates\/([^/]+)$/, async (req, res, match) => {
    const type = decodeURIComponent(match[1]);
    const db = await readDb();
    const rate = db.rates.find((item) => item.type === type);
    if (!rate) return send(res, 404, { error: "工价不存在" });
    rate.active = false;
    await writeDb(db);
    send(res, 200, { data: rate });
  });

  // ---- 拓片 ----
  app.route("GET", /^\/rubbings$/, async (req, res) => {
    const db = await readDb();
    const data = db.rubbings.map((rubbing) => {
      const damages = db.damages.filter((item) => item.rubbingId === rubbing.id);
      return {
        ...rubbing,
        damageCount: damages.length,
        pendingDamages: damages.filter((item) => item.status !== "repaired").length
      };
    });
    send(res, 200, { data });
  });

  app.route("POST", /^\/rubbings$/, async (req, res) => {
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
    const db = await readDb();
    db.rubbings.push(rubbing);
    await writeDb(db);
    send(res, 201, { data: rubbing });
  });

  // ---- 拓片缺损 ----
  app.route("GET", /^\/rubbings\/([^/]+)\/damages$/, async (req, res, match) => {
    const db = await readDb();
    findRubbing(db, match[1]);
    send(res, 200, { data: db.damages.filter((item) => item.rubbingId === match[1]) });
  });

  app.route("POST", /^\/rubbings\/([^/]+)\/damages$/, async (req, res, match) => {
    const rubbingId = match[1];
    const body = await parseBody(req);
    required(body, ["position", "type", "beforePhotoUrl"]);
    const db = await readDb();
    findRubbing(db, rubbingId);
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
      createdAt: new Date().toISOString(),
      repairedAt: null
    };
    db.damages.push(damage);
    await writeDb(db);
    send(res, 201, { data: damage });
  });

  // ---- 缺损项 ----
  app.route("GET", /^\/damages$/, async (req, res, _match, { url }) => {
    const db = await readDb();
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const data = db.damages.filter(
      (item) => (!status || item.status === status) && (!type || item.type === type)
    );
    send(res, 200, { data });
  });

  app.route("PATCH", /^\/damages\/([^/]+)$/, async (req, res, match) => {
    const db = await readDb();
    const damage = db.damages.find((item) => item.id === match[1]);
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
    send(res, 200, { data: damage });
  });

  // ---- 批次 ----
  app.route("GET", /^\/batches$/, async (req, res) => {
    const db = await readDb();
    send(res, 200, { data: db.batches.map((batch) => enrichBatch(db, batch)) });
  });

  app.route("POST", /^\/batches$/, async (req, res) => {
    const body = await parseBody(req);
    required(body, ["name", "damageIds"]);
    if (!Array.isArray(body.damageIds) || body.damageIds.length === 0) {
      return send(res, 400, { error: "damageIds必须是非空数组" });
    }
    const db = await readDb();
    const damages = body.damageIds.map((id) => {
      const damage = db.damages.find((item) => item.id === id);
      if (!damage) {
        const error = new Error(`缺损项不存在：${id}`);
        error.status = 400;
        throw error;
      }
      return damage;
    });
    const occupied = damages.filter((damage) => damage.batchId);
    if (occupied.length) {
      return send(res, 409, {
        error: `缺损项已在其他批次中：${occupied.map((d) => d.id).join(", ")}`
      });
    }

    // 建批时按缺损类型登记计价类别与预估工时，并对工价做快照
    const items = resolveItems(db.rates, damages, body.items);
    const estimated = {
      itemCount: items.length,
      totalHours: Math.round(items.reduce((s, i) => s + i.estimatedHours, 0) * 10) / 10,
      totalFee:
        Math.round(
          items.reduce((s, i) => s + i.fixedFee + i.estimatedHours * i.hourlyRate, 0) * 100
        ) / 100,
      currency: "CNY"
    };

    const batch = {
      id: makeId("batch"),
      name: body.name,
      status: "open",
      damageIds: body.damageIds,
      items,
      pricing: { estimated },
      settlement: null,
      note: body.note || "",
      createdAt: new Date().toISOString(),
      completedAt: null,
      cancelledAt: null
    };
    db.batches.push(batch);
    damages.forEach((damage) => {
      damage.batchId = batch.id;
      damage.status = "in_repair";
    });
    await writeDb(db);
    send(res, 201, { data: enrichBatch(db, batch) });
  });

  app.route("GET", /^\/batches\/([^/]+)$/, async (req, res, match) => {
    const db = await readDb();
    const batch = db.batches.find((item) => item.id === match[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    send(res, 200, { data: enrichBatch(db, batch) });
  });

  // 完工登记：超预估两成且无审批原因 -> 409 整批退回；结项后费用冻结
  app.route("POST", /^\/batches\/([^/]+)\/complete$/, async (req, res, match) => {
    const db = await readDb();
    const batch = db.batches.find((item) => item.id === match[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });

    // 幂等：已冻结则直接返回首次结算结果，不做任何写入
    if (batch.settlement && batch.settlement.frozen) {
      return send(res, 200, {
        data: enrichBatch(db, batch),
        settlement: batch.settlement,
        frozen: true,
        notice: "批次已结项，返回首次结算结果"
      });
    }
    if (batch.status === "cancelled") {
      return send(res, 409, { error: "批次已取消，不能完工登记", code: "BATCH_CANCELLED" });
    }

    const body = await parseBody(req);
    const damagesById = new Map(db.damages.map((damage) => [damage.id, damage]));
    try {
      settleCompletion(batch, damagesById, body);
    } catch (error) {
      if (error.status === 409) {
        // 整批退回：不落库，批次、费用、缺损状态都不变
        return send(res, 409, { error: error.message, code: error.code || "OVERTIME_APPROVAL_REQUIRED" });
      }
      throw error;
    }
    await writeDb(db);
    send(res, 200, { data: enrichBatch(db, batch), settlement: batch.settlement, frozen: true });
  });

  // 取消批次：只结算已开始项，未开始项不计费并释放
  app.route("POST", /^\/batches\/([^/]+)\/cancel$/, async (req, res, match) => {
    const db = await readDb();
    const batch = db.batches.find((item) => item.id === match[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    if (batch.settlement && batch.settlement.frozen) {
      return send(res, 200, {
        data: enrichBatch(db, batch),
        settlement: batch.settlement,
        frozen: true,
        notice: "批次已结项，返回首次结算结果"
      });
    }
    const body = await parseBody(req);
    const damagesById = new Map(db.damages.map((damage) => [damage.id, damage]));
    settleCancellation(batch, damagesById, body);
    await writeDb(db);
    send(res, 200, { data: enrichBatch(db, batch), settlement: batch.settlement, frozen: true });
  });

  routes.push(
    "GET /rates",
    "POST /rates",
    "PATCH /rates/:type",
    "DELETE /rates/:type",
    "POST /batches/:id/cancel"
  );
}

module.exports = { registerRoutes, defaultRateTable };
