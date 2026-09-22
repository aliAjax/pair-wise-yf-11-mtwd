const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");
const { registerRoutes, defaultRateTable } = require("./lib/routes");

const PORT = Number(process.env.PORT || 3020);
const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(__dirname, "data", "db.json");

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
      createdAt: new Date().toISOString(),
      repairedAt: null
    }
  ],
  batches: [],
  rates: defaultRateTable
};

const routes = [
  "GET /health",
  "GET /rubbings",
  "POST /rubbings",
  "GET /rubbings/:id/damages",
  "POST /rubbings/:id/damages",
  "GET /damages?status=&type=",
  "PATCH /damages/:id",
  "GET /batches",
  "POST /batches",
  "GET /batches/:id",
  "POST /batches/:id/complete"
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  let needInit = false;
  let data = null;
  try {
    data = JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    needInit = true;
  }
  if (!needInit) {
    // 旧库兼容：补出 rates / 新字段，不覆盖已有数据
    let changed = false;
    if (!Array.isArray(data.rates)) {
      data.rates = defaultRateTable;
      changed = true;
    }
    if (!Array.isArray(data.batches)) {
      data.batches = [];
      changed = true;
    }
    if (changed) await writeFile(DB_FILE, JSON.stringify(data, null, 2));
    return;
  }
  await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
}

async function readDb() {
  await ensureDb();
  return JSON.parse(await readFile(DB_FILE, "utf8"));
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

// 极简路由注册：method + pathname 正则，按注册顺序匹配
const handlers = [];
const app = {
  route(method, pattern, handler) {
    handlers.push({ method, pattern, handler });
  }
};

registerRoutes({ app, readDb, writeDb, routes });

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true, service: "rubbing-repair-api", routes });
  }

  for (const { method, pattern, handler } of handlers) {
    if (req.method !== method) continue;
    const match = url.pathname.match(pattern);
    if (match) return handler(req, res, match, { url });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) =>
    send(res, error.status || 500, { error: error.message || "服务器错误", code: error.code })
  );
});

server.listen(PORT, () => {
  console.log(`Rubbing repair API running at http://127.0.0.1:${PORT}`);
});
