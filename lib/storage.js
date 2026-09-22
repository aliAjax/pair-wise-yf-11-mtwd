const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const DB_FILE = path.join(__dirname, "..", "data", "db.json");

const initialData = {
  rubbings: [
    {
      id: "rubbing_demo",
      code: "TP-清-014",
      source: "地方碑刻残页",
      paperSize: "42x68cm",
      note: "边缘有旧折痕",
      createdAt: new Date().toISOString()
    }
  ],
  damages: [
    {
      id: "damage_demo_1",
      rubbingId: "rubbing_demo",
      position: "左上角第3列题字旁",
      type: "虫蛀孔",
      beforePhotoUrl: "https://example.local/before-014-1.jpg",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      startedAt: null,
      createdAt: new Date().toISOString(),
      repairedAt: null
    },
    {
      id: "damage_demo_2",
      rubbingId: "rubbing_demo",
      position: "下边缘中央",
      type: "撕裂",
      beforePhotoUrl: "https://example.local/before-014-2.jpg",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      startedAt: null,
      createdAt: new Date().toISOString(),
      repairedAt: null
    }
  ],
  priceList: [
    {
      id: "price_demo_1",
      damageType: "虫蛀孔",
      category: "精细补缀",
      hourlyRate: 120,
      defaultHours: 2,
      active: true,
      note: "按孔洞数量另计耗材",
      createdAt: new Date().toISOString(),
      updatedAt: null
    },
    {
      id: "price_demo_2",
      damageType: "撕裂",
      category: "揭裱托补",
      hourlyRate: 100,
      defaultHours: 3,
      active: true,
      note: "长边撕裂按比例上浮",
      createdAt: new Date().toISOString(),
      updatedAt: null
    }
  ],
  batches: []
};

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// 旧库平滑升级：补齐新增字段，不改动既有记录的取值
function migrate(db) {
  // 旧版没有工价表：注入种子工价，使既有 demo 缺损类型可直接建批
  if (!db.priceList) db.priceList = initialData.priceList.map((entry) => ({ ...entry }));
  for (const damage of db.damages || []) {
    if (damage.startedAt === undefined) damage.startedAt = null;
  }
  for (const batch of db.batches || []) {
    if (!Array.isArray(batch.pricing)) batch.pricing = [];
    if (!batch.settlement) batch.settlement = null;
    if (!batch.cancelledAt) batch.cancelledAt = null;
  }
  return db;
}

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  return migrate(JSON.parse(await readFile(DB_FILE, "utf8")));
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

module.exports = { DB_FILE, initialData, makeId, readDb, writeDb };
