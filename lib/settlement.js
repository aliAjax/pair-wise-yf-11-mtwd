// 结算规则模块：完工 / 取消结算、超预估工时审批校验、费用冻结与幂等
// 所有金额字段均为数字（元），两位小数由 roundMoney 统一处理，避免浮点尾巴。

const { OVERTIME_RATIO } = require("./pricing");

function httpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

// 单项费用 = 固定费用 + 实际/预估工时 * 小时单价
function priceItem(rateSnapshot, hours) {
  return roundMoney(rateSnapshot.fixedFee + hours * rateSnapshot.hourlyRate);
}

// 判断单项是否超预估两成：实际 > 预估 * 1.2
function isOverEstimate(item, actualHours) {
  return actualHours > item.estimatedHours * OVERTIME_RATIO;
}

function summarize(lines, extra = {}) {
  const totalHours = round1(lines.reduce((sum, line) => sum + line.hours, 0));
  const totalFee = roundMoney(lines.reduce((sum, line) => sum + line.fee, 0));
  const totalFixed = roundMoney(lines.reduce((sum, line) => sum + line.fixedFee, 0));
  const totalLabor = roundMoney(totalFee - totalFixed);
  return {
    itemCount: lines.length,
    totalHours,
    totalFixedFee: totalFixed,
    totalLaborFee: totalLabor,
    totalFee,
    currency: "CNY",
    ...extra
  };
}

function round1(value) {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function parseActualResults(body) {
  const results = Array.isArray(body.results) ? body.results : [];
  const map = new Map();
  for (const result of results) {
    if (!result || !result.damageId) {
      throw httpError(400, "results 中每项都必须包含 damageId");
    }
    map.set(result.damageId, result);
  }
  return map;
}

// 完工登记：
// 1) 结算已冻结 -> 幂等返回首次结果（调用方短路，这里不做写入）
// 2) 任一有结果的项实际工时超预估两成，却没有审批原因 -> 整批 409，不写任何状态
// 3) 通过则逐项登记实际工时、审批原因与费用，批次费用冻结
function settleCompletion(batch, damagesById, body) {
  if (batch.settlement && batch.settlement.frozen) {
    throw httpError(409, "批次已结项，费用已冻结，重复结算返回首次结果", "SETTLEMENT_FROZEN");
  }

  const resultMap = parseActualResults(body);
  const approvalReason = typeof body.approvalReason === "string" ? body.approvalReason.trim() : "";

  // 先做整批校验，全部通过后才落库，保证 409 时批次/费用/缺损状态都不变
  const violations = [];
  const parsed = [];
  for (const item of batch.items) {
    const result = resultMap.get(item.damageId) || {};
    const actualHours = Number(result.actualHours);
    if (!Number.isFinite(actualHours) || actualHours < 0) {
      throw httpError(400, `缺损项 ${item.damageId} 的 actualHours 必须是非负数字`);
    }
    const itemReason = (result.approvalReason ? String(result.approvalReason).trim() : "") || approvalReason;
    if (isOverEstimate(item, actualHours) && !itemReason) {
      violations.push({
        damageId: item.damageId,
        estimatedHours: item.estimatedHours,
        actualHours,
        limitHours: round1(item.estimatedHours * OVERTIME_RATIO)
      });
    }
    parsed.push({ result, actualHours, itemReason });
  }

  if (violations.length) {
    throw httpError(
      409,
      `实际工时超出预估两成且缺少审批原因，整批退回：${violations.map((v) => v.damageId).join(", ")}`,
      "OVERTIME_APPROVAL_REQUIRED"
    );
  }

  const lines = [];
  parsed.forEach(({ result, actualHours, itemReason }, index) => {
    const item = batch.items[index];
    const fee = priceItem(item, actualHours);
    const over = isOverEstimate(item, actualHours);
    lines.push({
      damageId: item.damageId,
      damageType: item.damageType,
      category: item.category,
      categoryName: item.categoryName,
      hourlyRate: item.hourlyRate,
      fixedFee: item.fixedFee,
      estimatedHours: item.estimatedHours,
      actualHours: round1(actualHours),
      hours: round1(actualHours),
      fee,
      billed: true,
      started: true,
      overEstimate: over,
      approvalReason: over ? itemReason : itemReason || ""
    });
    const damage = damagesById.get(item.damageId);
    if (damage) {
      damage.status = "repaired";
      damage.afterPhotoUrl = result.afterPhotoUrl || body.defaultAfterPhotoUrl || damage.afterPhotoUrl;
      damage.repairNote = result.repairNote || body.defaultRepairNote || damage.repairNote;
      damage.repairedAt = new Date().toISOString();
    }
  });

  const settlement = {
    kind: "completion",
    status: "frozen",
    frozen: true,
    approvalReason,
    lines,
    ...summarize(lines),
    settledAt: new Date().toISOString()
  };

  batch.status = "completed";
  batch.completedAt = settlement.settledAt;
  batch.note = body.note ?? batch.note;
  batch.settlement = settlement;
  return settlement;
}

// 取消批次：只结算已开始项（in_repair / repaired），未开始（pending）不计费
// 已开始但未报实际工时的项按预估工时结算；未开始项保留在清单中但 billed=false、fee=0
function settleCancellation(batch, damagesById, body = {}) {
  if (batch.settlement && batch.settlement.frozen) {
    throw httpError(409, "批次已结项，费用已冻结，无法取消", "SETTLEMENT_FROZEN");
  }

  const resultMap = parseActualResults(body);
  const lines = [];
  const settledAt = new Date().toISOString();

  for (const item of batch.items) {
    const damage = damagesById.get(item.damageId);
    const started = !!damage && damage.status !== "pending";
    const result = resultMap.get(item.damageId) || {};

    if (!started) {
      lines.push({
        damageId: item.damageId,
        damageType: item.damageType,
        category: item.category,
        categoryName: item.categoryName,
        hourlyRate: item.hourlyRate,
        fixedFee: item.fixedFee,
        estimatedHours: item.estimatedHours,
        actualHours: 0,
        hours: 0,
        fee: 0,
        billed: false,
        started: false,
        overEstimate: false,
        approvalReason: ""
      });
      if (damage) {
        // 未开始项解除批次占用，回到待修补，不计费
        damage.batchId = null;
        damage.status = "pending";
      }
      continue;
    }

    // 已开始项：有实际工时按实际，没有则按预估兜底
    let hours;
    if (result.actualHours !== undefined) {
      hours = Number(result.actualHours);
      if (!Number.isFinite(hours) || hours < 0) {
        throw httpError(400, `缺损项 ${item.damageId} 的 actualHours 必须是非负数字`);
      }
    } else {
      hours = item.estimatedHours;
    }
    const itemReason = result.approvalReason ? String(result.approvalReason).trim() : "";
    const fee = priceItem(item, hours);
    const over = isOverEstimate(item, hours);
    lines.push({
      damageId: item.damageId,
      damageType: item.damageType,
      category: item.category,
      categoryName: item.categoryName,
      hourlyRate: item.hourlyRate,
      fixedFee: item.fixedFee,
      estimatedHours: item.estimatedHours,
      actualHours: round1(hours),
      hours: round1(hours),
      fee,
      billed: true,
      started: true,
      overEstimate: over,
      approvalReason: over ? itemReason : itemReason
    });
    if (damage) {
      // 已开始但取消：标记为取消未完成，保留批次归属便于追溯
      damage.status = "cancelled";
      damage.repairNote = result.repairNote || damage.repairNote;
    }
  }

  const billedLines = lines.filter((line) => line.billed);
  const settlement = {
    kind: "cancellation",
    status: "frozen",
    frozen: true,
    reason: typeof body.reason === "string" ? body.reason.trim() : "",
    lines,
    ...summarize(billedLines),
    skippedCount: lines.length - billedLines.length,
    settledAt
  };

  batch.status = "cancelled";
  batch.cancelledAt = settledAt;
  if (body.note !== undefined) batch.note = body.note;
  batch.settlement = settlement;
  return settlement;
}

module.exports = {
  roundMoney,
  priceItem,
  isOverEstimate,
  settleCompletion,
  settleCancellation
};
