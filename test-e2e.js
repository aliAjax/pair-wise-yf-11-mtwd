// 端到端验证：工价表、建批计价、409 整批退回、取消部分结算、冻结幂等
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");

const PORT = 3199;
const dbFile = path.join(__dirname, "data", "test.db.json");
try { fs.unlinkSync(dbFile); } catch {}

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: PORT,
        path: urlPath,
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {}
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let json = null;
          try { json = raw ? JSON.parse(raw) : null; } catch { json = raw; }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let failures = 0;
function assert(cond, label, extra) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}`, extra !== undefined ? JSON.stringify(extra) : "");
  }
}

async function waitHealthy(retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await request("GET", "/health");
      if (res.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(PORT), DB_FILE: dbFile },
    stdio: "ignore"
  });
  await waitHealthy();

  try {
    console.log("1) 工价表独立维护");
    const rates = await request("GET", "/rates?active=true");
    assert(rates.status === 200, "GET /rates 200");
    assert(rates.body.data.some((r) => r.type === "虫蛀孔" && r.hourlyRate === 120), "默认虫蛀孔工价存在");

    const updated = await request("POST", "/rates", {
      type: "虫蛀孔", category: "fine_patch", categoryName: "精细补洞", hourlyRate: 130, fixedFee: 35
    });
    assert(updated.status === 200 && updated.body.data.hourlyRate === 130, "同工价类型 upsert 更新单价");

    const newType = await request("POST", "/rates", {
      type: "烟熏焦痕", category: "deacidify", categoryName: "脱酸去焦", hourlyRate: 200, fixedFee: 80
    });
    assert(newType.status === 201 && newType.body.data.type === "烟熏焦痕", "新增工价类型 201");

    const patched = await request("PATCH", encodeURI("/rates/撕裂"), { fixedFee: 25 });
    assert(patched.status === 200 && patched.body.data.fixedFee === 25 && patched.body.data.hourlyRate === 100, "PATCH 只改部分字段");

    console.log("2) 建批登记计价类别与预估工时（快照）");
    const batch1 = await request("POST", "/batches", {
      name: "批次A-正常完工",
      damageIds: ["damage_demo_1", "damage_demo_2"],
      items: [
        { damageId: "damage_demo_1", estimatedHours: 3 },
        { damageId: "damage_demo_2", estimatedHours: 2 }
      ]
    });
    assert(batch1.status === 201, "建批 201", batch1.body);
    const b1 = batch1.body.data;
    assert(b1.items.length === 2, "批次内含 2 个计价明细");
    assert(b1.items[0].category === "fine_patch" && b1.items[0].hourlyRate === 130, "虫蛀孔按最新工价快照 130");
    assert(b1.items[1].category === "fiber_rejoin" && b1.items[1].fixedFee === 25, "撕裂固定费快照 25");
    // 预估：虫蛀孔 35 + 3*130 = 425；撕裂 25 + 2*100 = 225；合计 650
    assert(b1.pricing.estimated.totalFee === 650, `预估费用 650（实际 ${b1.pricing.estimated.totalFee}）`);
    assert(b1.pricing.estimated.totalHours === 5, "预估工时 5");
    assert(b1.total === 2 && b1.pending === 2 && b1.repaired === 0, "兼容字段 total/repaired/pending 保留（pending 沿用原语义=非repaired数）");

    // 建批后调价不影响在途批次快照
    await request("POST", "/rates", {
      type: "虫蛀孔", category: "fine_patch", categoryName: "精细补洞", hourlyRate: 999, fixedFee: 999
    });

    console.log("3) 缺损类型无工价时拒绝建批");
    const rubbingRes = await request("GET", "/rubbings");
    const rubId = rubbingRes.body.data[0].id;
    const noRateDamage = await request("POST", `/rubbings/${rubId}/damages`, {
      position: "背面空白处", type: "未配置类型", beforePhotoUrl: "http://x/y.jpg"
    });
    const badBatch = await request("POST", "/batches", {
      name: "无工价", damageIds: [noRateDamage.body.data.id],
      items: [{ damageId: noRateDamage.body.data.id, estimatedHours: 1 }]
    });
    assert(badBatch.status === 400 && /工价/.test(badBatch.body.error), "缺工价建批 400", badBatch.body);

    console.log("4) 完工超预估两成且无审批原因 → 整批 409，数据不变");
    // 虫蛀孔预估 3h，阈值 3.6h；上报 4h 超限。撕裂 2h 正常
    const before409 = await request("GET", `/batches/${b1.id}`);
    const overRes = await request("POST", `/batches/${b1.id}/complete`, {
      results: [
        { damageId: "damage_demo_1", actualHours: 4, afterPhotoUrl: "http://x/a.jpg", repairNote: "补好" },
        { damageId: "damage_demo_2", actualHours: 2 }
      ]
    });
    assert(overRes.status === 409, "超两成无审批 → 409", overRes.body);
    assert(overRes.body.code === "OVERTIME_APPROVAL_REQUIRED", "返回业务错误码");
    const after409 = await request("GET", `/batches/${b1.id}`);
    assert(after409.body.data.status === "open", "批次状态仍为 open");
    assert(after409.body.data.settlement === null, "批次仍无结算记录");
    const dmgAfter409 = (await request("GET", "/damages")).body.data;
    const d1 = dmgAfter409.find((d) => d.id === "damage_demo_1");
    assert(d1.status === "in_repair" && d1.afterPhotoUrl === "", "缺损状态/照片未被改写");
    assert(JSON.stringify(after409.body.data.items) === JSON.stringify(before409.body.data.items), "计价快照不变");

    console.log("5) 补审批原因后完工成功，费用按快照工价冻结");
    const okRes = await request("POST", `/batches/${b1.id}/complete`, {
      approvalReason: "虫蛀连片需剔纸重补，已经主管批准",
      results: [
        { damageId: "damage_demo_1", actualHours: 4, afterPhotoUrl: "http://x/a.jpg", repairNote: "补好" },
        { damageId: "damage_demo_2", actualHours: 2, afterPhotoUrl: "http://x/b.jpg", repairNote: "接笔" }
      ]
    });
    assert(okRes.status === 200, "带审批原因完工 200", okRes.body);
    const st = okRes.body.settlement;
    assert(st.frozen === true && st.kind === "completion", "结算冻结标记");
    // 虫蛀孔：35 + 4*130 = 555；撕裂：25 + 2*100 = 225；合计 780（未受后续调价 999 影响）
    assert(st.totalFee === 780, `冻结总费用 780（实际 ${st.totalFee}）`);
    assert(st.totalHours === 6, "实际总工时 6");
    assert(st.lines[0].overEstimate === true && st.lines[0].approvalReason.includes("主管"), "超限项带审批原因");
    assert(st.lines[1].overEstimate === false, "未超限项标记 false");

    const firstSettlementJson = JSON.stringify(st);
    console.log("6) 结项后重复结算幂等返回首次结果");
    const repeat = await request("POST", `/batches/${b1.id}/complete`, {
      results: [
        { damageId: "damage_demo_1", actualHours: 100 },
        { damageId: "damage_demo_2", actualHours: 100 }
      ]
    });
    assert(repeat.status === 200 && repeat.body.frozen === true, "重复完工 200 且标记 frozen");
    assert(JSON.stringify(repeat.body.settlement) === firstSettlementJson, "重复结算返回首次结果，费用不变");
    const repeatCancel = await request("POST", `/batches/${b1.id}/cancel`, {});
    assert(repeatCancel.status === 200 && JSON.stringify(repeatCancel.body.settlement) === firstSettlementJson,
      "对已结项批次取消也幂等返回首次结果");

    console.log("7) 取消批次：只结算已开始项，未开始项不计费并释放");
    // 新建批次，其中一项手工退回 pending 模拟未开始
    const dmg3 = await request("POST", `/rubbings/${rubId}/damages`, {
      position: "右上角", type: "虫蛀孔", beforePhotoUrl: "http://x/3.jpg"
    });
    const dmg4 = await request("POST", `/rubbings/${rubId}/damages`, {
      position: "左下角", type: "撕裂", beforePhotoUrl: "http://x/4.jpg"
    });
    const batch2 = await request("POST", "/batches", {
      name: "批次B-取消",
      damageIds: [dmg3.body.data.id, dmg4.body.data.id],
      items: [
        { damageId: dmg3.body.data.id, estimatedHours: 2 },
        { damageId: dmg4.body.data.id, estimatedHours: 4 }
      ]
    });
    const b2id = batch2.body.data.id;
    // 把 dmg4 退回未开始
    await request("PATCH", `/damages/${dmg4.body.data.id}`, { status: "pending" });

    const cancelRes = await request("POST", `/batches/${b2id}/cancel`, {
      reason: "库房整修复暂停",
      results: [{ damageId: dmg3.body.data.id, actualHours: 1.5 }]
    });
    assert(cancelRes.status === 200, "取消 200", cancelRes.body);
    const cs = cancelRes.body.settlement;
    assert(cs.kind === "cancellation" && cs.frozen === true, "取消结算冻结");
    // 已开始虫蛀孔（调价后建批，单价 999，固定费 999）：999 + 1.5*999 = 2497.5
    assert(cs.itemCount === 1 && cs.totalFee === 2497.5, `只结算 1 个已开始项，费用 2497.5（实际 ${cs.totalFee}）`, cs);
    assert(cs.skippedCount === 1, "未开始项计数 1");
    const skipped = cs.lines.find((l) => l.damageId === dmg4.body.data.id);
    assert(skipped.billed === false && skipped.fee === 0 && skipped.started === false, "未开始项 billed=false/fee=0");

    const dmg4After = (await request("GET", `/damages/${encodeURIComponent(dmg4.body.data.id)}`).catch(() => null)) ||
      (await request("GET", `/damages?status=pending`));
    const pendingList = (await request("GET", "/damages?status=pending")).body.data;
    assert(pendingList.some((d) => d.id === dmg4.body.data.id), "未开始项回到 pending 并释放");
    const dmg3After = (await request("GET", "/damages?status=cancelled")).body.data;
    assert(dmg3After.some((d) => d.id === dmg3.body.data.id), "已开始项标记 cancelled");

    console.log("8) 取消时已开始但未报实际工时 → 按预估兜底计费");
    const dmg5 = await request("POST", `/rubbings/${rubId}/damages`, {
      position: "碑额", type: "撕裂", beforePhotoUrl: "http://x/5.jpg"
    });
    const batch3 = await request("POST", "/batches", {
      name: "批次C-取消按预估", damageIds: [dmg5.body.data.id],
      items: [{ damageId: dmg5.body.data.id, estimatedHours: 3 }]
    });
    const cancel3 = await request("POST", `/batches/${batch3.body.data.id}/cancel`, {});
    // 撕裂：固定 25 + 3*100 = 325
    assert(cancel3.body.settlement.totalFee === 325, `无实际工时按预估结算 325（实际 ${cancel3.body.settlement.totalFee}）`);

    console.log("9) 响应字段兼容性");
    const listRes = await request("GET", "/batches");
    const anyBatch = listRes.body.data[0];
    for (const field of ["id", "name", "status", "damageIds", "note", "createdAt", "completedAt", "damages", "total", "repaired", "pending"]) {
      assert(field in anyBatch, `批次字段 ${field} 保留`);
    }
  } finally {
    server.kill();
    try { fs.unlinkSync(dbFile); } catch {}
  }

  if (failures) {
    console.error(`\n${failures} 个断言失败`);
    process.exit(1);
  }
  console.log("\n全部断言通过");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
