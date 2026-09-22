# 古籍拓片缺损修补API

纯后端零依赖Node服务，使用 `data/db.json` 持久化拓片、缺损项、工价表和修补批次。

## 启动

```bash
PORT=3020 node server.js
```

## 代码结构

- `lib/priceList.js` —— 工价表业务模块：按缺损类型维护计价类别、工时单价与默认工时
- `lib/settlement.js` —— 结算规则模块：建批计价登记、完工超预估审批校验、取消部分结算、费用冻结
- `lib/routes.js` —— 路由模块：HTTP 编排与响应
- `lib/storage.js` / `lib/http.js` —— JSON 持久化与请求工具

## 主要接口

- `GET /health`
- `GET /rubbings` / `POST /rubbings`
- `GET /rubbings/:id/damages` / `POST /rubbings/:id/damages`
- `GET /damages?status=&type=` / `PATCH /damages/:id`
- `GET /price-list?active=` / `POST /price-list` / `GET /price-list/:id` / `PATCH /price-list/:id`
- `GET /batches` / `POST /batches` / `GET /batches/:id`
- `POST /batches/:id/start`（开工登记）
- `POST /batches/:id/complete`（完工结算）
- `POST /batches/:id/cancel`（取消批次）

## 计价结算规则

1. **工价表独立维护**：每种缺损类型对应一条生效工价（`damageType` + `category` + `hourlyRate` +
   `defaultHours`）。同一类型只能有一条生效工价，调整工价可用 PATCH 停用或改价。
2. **建批即登记计价**：`POST /batches` 时按每个缺损项的类型快照计价类别、单价与预估工时；
   未在工价表登记的类型不允许建批。可在 `estimatedHours` 中按缺损 id 覆盖预估工时，
   缺省取工价表的 `defaultHours`。建批后工价表调价不影响在批批次（单价已快照）。
3. **完工登记实际工时**：`POST /batches/:id/complete` 的 `results` 中每项必须带
   `actualHours`。任一已登记项实际工时**超出预估两成**（`actual > estimated × 1.2`）且请求体
   没有写清 `approvalReason`（非空白、不少于4字）时，整批返回 **409**，批次、费用与缺损状态
   全部不变。
4. **取消只结算已开工项**：先通过 `POST /batches/:id/start` 登记开工（支持部分开工，
   不传 `damageIds` 视为全部开工）。`POST /batches/:id/cancel` 时只对已开工项按
   `actualHours` 计费，没开始的项不计费并释放回 `pending`，可重新组批；已开工项保留
   `in_repair` 状态、脱离批次。
5. **费用冻结**：批次一旦 `completed` 或 `cancelled`，费用即冻结；重复调用结算接口直接返回
   第一次的结算结果（响应带 `"frozen": true`），已结项批次不能再取消/开工，反之亦然。

批次响应在原有字段（`damages`、`total`、`repaired`、`pending` 等）基础上新增
`pricing`、`settlement`、`estimatedFee`、`fee`，旧字段含义与取值保持不变。

## 闭环示例

```bash
# 维护工价
curl http://127.0.0.1:3020/price-list
curl -X POST http://127.0.0.1:3020/price-list \
  -H 'Content-Type: application/json' \
  -d '{"damageType":"霉变","category":"除霉杀菌","hourlyRate":150,"defaultHours":4}'

# 建批（按缺损类型登记计价类别与预估工时）
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","damageIds":["damage_demo_1","damage_demo_2"],"estimatedHours":{"damage_demo_1":5}}'

# 部分开工 -> 完工结算（超预估20%需带 approvalReason）
curl -X POST http://127.0.0.1:3020/batches/<batchId>/start \
  -H 'Content-Type: application/json' -d '{"damageIds":["damage_demo_1"]}'
curl -X POST http://127.0.0.1:3020/batches/<batchId>/complete \
  -H 'Content-Type: application/json' \
  -d '{"results":[{"damageId":"damage_demo_1","actualHours":6.1},{"damageId":"damage_demo_2","actualHours":3}],"approvalReason":"孔洞连片，已由修复主管现场审批"}'
```
