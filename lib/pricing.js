// 工价表模块：按缺损类型维护计价类别、小时单价与固定费用
// 工价表独立于批次存储；建批时把命中的工价快照进批次，后续调价不影响在途批次。

const OVERTIME_RATIO = 1.2; // 实际工时超过预估两成（即 > 预估 * 1.2）触发审批校验

// 默认工价表，初始化数据库时写入；可通过接口维护
const defaultRateTable = [
  {
    type: "虫蛀孔",
    category: "fine_patch",
    categoryName: "精细补洞",
    hourlyRate: 120,
    fixedFee: 30,
    active: true
  },
  {
    type: "撕裂",
    category: "fiber_rejoin",
    categoryName: "纤维接笔",
    hourlyRate: 100,
    fixedFee: 20,
    active: true
  },
  {
    type: "霉斑",
    category: "cleaning",
    categoryName: "除霉清洗",
    hourlyRate: 90,
    fixedFee: 0,
    active: true
  },
  {
    type: "缺角",
    category: "paper_infill",
    categoryName: "配纸补全",
    hourlyRate: 150,
    fixedFee: 50,
    active: true
  }
];

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeRate(rate) {
  return {
    type: String(rate.type),
    category: String(rate.category),
    categoryName: rate.categoryName ?? "",
    hourlyRate: Number(rate.hourlyRate),
    fixedFee: Number(rate.fixedFee ?? 0),
    active: rate.active !== false
  };
}

function validateRateInput(body) {
  if (!body || typeof body !== "object") throw httpError(400, "请求体必须是JSON对象");
  if (!body.type) throw httpError(400, "缺少字段：type");
  if (!body.category) throw httpError(400, "缺少字段：category");
  const hourlyRate = Number(body.hourlyRate);
  if (!Number.isFinite(hourlyRate) || hourlyRate < 0) {
    throw httpError(400, "hourlyRate必须是非负数字");
  }
  const fixedFee = Number(body.fixedFee ?? 0);
  if (!Number.isFinite(fixedFee) || fixedFee < 0) {
    throw httpError(400, "fixedFee必须是非负数字");
  }
  return normalizeRate({ ...body, hourlyRate, fixedFee });
}

// 查询某缺损类型当前生效的工价
function findActiveRate(rateTable, damageType) {
  return rateTable.find((rate) => rate.active && rate.type === damageType) || null;
}

// 建批时为每个缺损项解析工价；任何一项缺工价都拒绝建批（避免事后计价争议）
function resolveItems(rateTable, damages, bodyItems) {
  const itemMap = new Map((bodyItems || []).map((item) => [item.damageId, item]));
  return damages.map((damage) => {
    const item = itemMap.get(damage.id) || {};
    const estimatedHours = Number(item.estimatedHours);
    if (!Number.isFinite(estimatedHours) || estimatedHours < 0) {
      throw httpError(400, `缺损项 ${damage.id} 的 estimatedHours 必须是非负数字`);
    }
    const override = item.category ? { category: String(item.category) } : null;
    const rate = findActiveRate(rateTable, damage.type);
    if (!rate) {
      throw httpError(400, `缺损类型「${damage.type}」尚未配置生效工价，无法建批`);
    }
    const category = override ? override.category : rate.category;
    if (override && category !== rate.category) {
      // 允许建批时显式登记不同计价类别，但必须仍在工价表中存在且单价按该类别取
      const categoryRate = rateTable.find((r) => r.active && r.category === category);
      if (!categoryRate) throw httpError(400, `计价类别 ${category} 不存在或未生效`);
      return {
        damageId: damage.id,
        damageType: damage.type,
        category,
        categoryName: categoryRate.categoryName,
        hourlyRate: categoryRate.hourlyRate,
        fixedFee: categoryRate.fixedFee,
        estimatedHours
      };
    }
    return {
      damageId: damage.id,
      damageType: damage.type,
      category: rate.category,
      categoryName: rate.categoryName,
      hourlyRate: rate.hourlyRate,
      fixedFee: rate.fixedFee,
      estimatedHours
    };
  });
}

module.exports = {
  OVERTIME_RATIO,
  defaultRateTable,
  normalizeRate,
  validateRateInput,
  findActiveRate,
  resolveItems
};
