# 古籍拓片缺损修补API

纯后端零依赖Node服务，使用 `data/db.json` 持久化拓片、缺损项、修补批次与工价表。

## 启动

```bash
PORT=3020 node server.js
# 测试时可用 DB_FILE 指向独立数据文件
PORT=3200 DB_FILE=/tmp/test.db.json node server.js
```

## 主要接口

### 基础
- `GET /health`
- `GET /rubbings`
- `POST /rubbings`
- `GET /rubbings/:id/damages`
- `POST /rubbings/:id/damages`
- `GET /damages?status=&type=`
- `PATCH /damages/:id`

### 工价表（独立维护，按缺损类型）
- `GET /rates?active=true&type=虫蛀孔`
- `POST /rates`：按 `type` upsert（`category` / `categoryName` / `hourlyRate` / `fixedFee` / `active`）
- `PATCH /rates/:type`：部分字段更新
- `DELETE /rates/:type`：停用（软删除，保留历史快照可追溯）

### 批次与结算
- `GET /batches`
- `POST /batches`
- `GET /batches/:id`
- `POST /batches/:id/complete`：完工登记实际工时并结算
- `POST /batches/:id/cancel`：取消批次，只结算已开始项

## 计价结算规则

1. **建批计价**：`POST /batches` 的 `items` 中每项必须给 `damageId` 与 `estimatedHours`；
   系统按缺损类型从工价表取计价类别、小时单价、固定费，连同预估工时一起快照进批次。
   缺工价的类型不允许建批；建批后调价不影响在途批次。
2. **超预估审批**：完工时任一有结果项实际工时 `> 预估 × 1.2`，
   且该批次/该项都没写 `approvalReason`，整批返回 `409 OVERTIME_APPROVAL_REQUIRED`，
   批次状态、费用、缺损状态与照片均不变更。
3. **取消结算**：`POST /batches/:id/cancel` 只对已开始项（`in_repair` 等）计费，
   未开始项（`pending`）`billed=false`、费用 0 并释放回待修补；
   已开始但未报 `actualHours` 的按预估工时兜底。
4. **冻结与幂等**：完工或取消成功后 `settlement.frozen=true`；
   对已结项批次再次 complete / cancel，直接返回首次结算结果，不重复计费。

费用模型：单项费用 = `fixedFee + hours × hourlyRate`，金额保留两位小数（CNY）。

## 闭环示例

```bash
# 维护工价
curl -X POST http://127.0.0.1:3020/rates \
  -H 'Content-Type: application/json' \
  -d '{"type":"虫蛀孔","category":"fine_patch","categoryName":"精细补洞","hourlyRate":120,"fixedFee":30}'

# 建批并登记预估工时
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"六月小批修补",
    "damageIds":["damage_demo_1","damage_demo_2"],
    "items":[
      {"damageId":"damage_demo_1","estimatedHours":3},
      {"damageId":"damage_demo_2","estimatedHours":2}
    ]
  }'

# 完工登记实际工时（超两成需带审批原因，否则整批 409）
curl -X POST http://127.0.0.1:3020/batches/<batchId>/complete \
  -H 'Content-Type: application/json' \
  -d '{
    "approvalReason":"虫蛀连片需剔纸重补，经主管批准",
    "results":[
      {"damageId":"damage_demo_1","actualHours":4,"afterPhotoUrl":"https://example.local/a.jpg","repairNote":"补好"},
      {"damageId":"damage_demo_2","actualHours":2}
    ]
  }'

# 取消批次：只结算已开始项
curl -X POST http://127.0.0.1:3020/batches/<batchId>/cancel \
  -H 'Content-Type: application/json' \
  -d '{"reason":"库房整修复暂停"}'
```

## 模块结构

- `lib/pricing.js`：工价表与建批计价快照
- `lib/settlement.js`：完工/取消结算、超预估审批、费用冻结幂等
- `lib/routes.js`：HTTP 路由与响应
- `server.js`：启动入口、JSON 存储与旧库兼容迁移

## 测试

```bash
node test-e2e.js
```

端到端覆盖工价维护、建批快照、409 整批退回且数据不变、审批通过结算、
取消只结算已开始项、按预估兜底、结项冻结幂等与旧字段兼容。
