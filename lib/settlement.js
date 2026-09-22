// 结算规则模块：建批计价登记、完工超预估校验、取消部分结算、费用冻结
const { httpError } = require("./http");
const { activeEntryForType, nonNegativeNumber } = require("./priceList");

const OVERRUN_RATIO = 1.2;

function round2(value) {
  return Math.round(value * 100) / 100;
}

// 建批时按缺损类型登记计价类别与预估工时，并快照单价（工价表后续调整不影响在批批次）
function registerPricing(db, damages, estimatedOverrides = {}) {
  return damages.map((damage) => {
    const entry = activeEntryForType(db, damage.type);
    if (!entry) {
      throw httpError(400, `缺损类型「${damage.type}」没有生效工价，请先在工价表中登记`);
    }
    let estimatedHours;
    if (estimatedOverrides[damage.id] !== undefined) {
      estimatedHours = nonNegativeNumber(estimatedOverrides[damage.id], `预估工时(${damage.id})`);
    } else {
      if (entry.defaultHours === null || entry.defaultHours === undefined) {
        throw httpError(400, `缺损「${damage.id}」的工价条目未配置默认工时，建批时需显式提供预估工时`);
      }
      estimatedHours = entry.defaultHours;
    }
    return {
      damageId: damage.id,
      damageType: damage.type,
      category: entry.category,
      priceId: entry.id,
      hourlyRate: entry.hourlyRate,
      estimatedHours,
      started: false
    };
  });
}

function estimatedTotal(pricing) {
  return round2(pricing.reduce((sum, item) => sum + item.estimatedHours * item.hourlyRate, 0));
}

function approvalProvided(text) {
  return typeof text === "string" && text.trim().length >= 4;
}

// 完工校验：任一已登记项实际工时超过预估两成，又没有写清审批原因时，整批拦截
function assertCompletionAllowed(pricing, actualHoursMap, approvalReason) {
  const overruns = pricing.filter((item) => {
    const actual = actualHoursMap[item.damageId];
    return typeof actual === "number" && actual > item.estimatedHours * OVERRUN_RATIO;
  });
  if (overruns.length > 0 && !approvalProvided(approvalReason)) {
    throw httpError(
      409,
      `以下缺损项实际工时超出预估20%且未写清审批原因：${overruns.map((item) => item.damageId).join(", ")}`
    );
  }
}

function lineResult(pricingItem, actualHours) {
  return {
    damageId: pricingItem.damageId,
    damageType: pricingItem.damageType,
    category: pricingItem.category,
    started: pricingItem.started,
    estimatedHours: pricingItem.estimatedHours,
    actualHours,
    hourlyRate: pricingItem.hourlyRate,
    fee: round2((actualHours || 0) * pricingItem.hourlyRate)
  };
}

// 完工结算：每项按实际工时计价
function settleCompletion(pricing, actualHoursMap, { approvalReason = "", note = "" } = {}) {
  const lines = pricing.map((item) => lineResult(item, actualHoursMap[item.damageId] || 0));
  return {
    kind: "completion",
    reason: approvalReason ? approvalReason.trim() : "",
    note: note || "",
    lines,
    estimatedHours: round2(pricing.reduce((sum, item) => sum + item.estimatedHours, 0)),
    actualHours: round2(lines.reduce((sum, line) => sum + line.actualHours, 0)),
    totalFee: round2(lines.reduce((sum, line) => sum + line.fee, 0)),
    settledAt: new Date().toISOString()
  };
}

// 取消结算：仅已开工项按实际工时计费，未开工项不计费
function settleCancellation(pricing, actualHoursMap, { reason = "" } = {}) {
  const lines = pricing.map((item) => {
    if (!item.started) return lineResult(item, null);
    return lineResult(item, actualHoursMap[item.damageId] || 0);
  });
  const billed = lines.filter((line) => line.started);
  return {
    kind: "cancellation",
    reason: reason || "",
    lines,
    startedCount: billed.length,
    waivedCount: lines.length - billed.length,
    estimatedHours: round2(pricing.reduce((sum, item) => sum + (item.started ? item.estimatedHours : 0), 0)),
    actualHours: round2(billed.reduce((sum, line) => sum + line.actualHours, 0)),
    totalFee: round2(billed.reduce((sum, line) => sum + line.fee, 0)),
    settledAt: new Date().toISOString()
  };
}

module.exports = {
  OVERRUN_RATIO,
  registerPricing,
  estimatedTotal,
  approvalProvided,
  assertCompletionAllowed,
  settleCompletion,
  settleCancellation
};
