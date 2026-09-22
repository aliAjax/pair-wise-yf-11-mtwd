// 工价表模块：按缺损类型维护计价类别、工时单价与默认预估工时
const { makeId } = require("./storage");
const { httpError } = require("./http");

function listEntries(db, { active } = {}) {
  // 查询参数缺省时 get() 返回 null，空串同样视为不过滤
  if (active === undefined || active === null || active === "") return db.priceList;
  const flag = active === "true";
  return db.priceList.filter((entry) => entry.active === flag);
}

function getEntry(db, id) {
  const entry = db.priceList.find((item) => item.id === id);
  if (!entry) throw httpError(404, "工价条目不存在");
  return entry;
}

// 某缺损类型当前生效的工价条目
function activeEntryForType(db, damageType) {
  return db.priceList.find((item) => item.damageType === damageType && item.active) || null;
}

function nonNegativeNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw httpError(400, `${field}必须是非负数字`);
  }
  return value;
}

function createEntry(db, body) {
  if (activeEntryForType(db, body.damageType)) {
    throw httpError(409, `缺损类型「${body.damageType}」已有生效工价，请先停用或修改原条目`);
  }
  nonNegativeNumber(body.hourlyRate, "hourlyRate");
  const entry = {
    id: makeId("price"),
    damageType: body.damageType,
    category: body.category,
    hourlyRate: body.hourlyRate,
    defaultHours: body.defaultHours === undefined || body.defaultHours === null ? null : nonNegativeNumber(body.defaultHours, "defaultHours"),
    active: body.active === undefined ? true : Boolean(body.active),
    note: body.note || "",
    createdAt: new Date().toISOString(),
    updatedAt: null
  };
  db.priceList.push(entry);
  return entry;
}

function updateEntry(db, id, body) {
  const entry = getEntry(db, id);
  if (body.damageType !== undefined) {
    const other = activeEntryForType(db, body.damageType);
    if (other && other.id !== entry.id) {
      throw httpError(409, `缺损类型「${body.damageType}」已有生效工价`);
    }
    entry.damageType = body.damageType;
  }
  if (body.category !== undefined) entry.category = body.category;
  if (body.hourlyRate !== undefined) entry.hourlyRate = nonNegativeNumber(body.hourlyRate, "hourlyRate");
  if (body.defaultHours !== undefined) {
    entry.defaultHours = body.defaultHours === null ? null : nonNegativeNumber(body.defaultHours, "defaultHours");
  }
  if (body.note !== undefined) entry.note = body.note;
  if (body.active !== undefined) {
    if (body.active) {
      const other = activeEntryForType(db, entry.damageType);
      if (other && other.id !== entry.id) {
        throw httpError(409, `缺损类型「${entry.damageType}」已有生效工价`);
      }
    }
    entry.active = Boolean(body.active);
  }
  entry.updatedAt = new Date().toISOString();
  return entry;
}

module.exports = { listEntries, getEntry, activeEntryForType, createEntry, updateEntry, nonNegativeNumber };
