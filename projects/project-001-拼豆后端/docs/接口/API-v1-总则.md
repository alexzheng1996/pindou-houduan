# API v1 总则

> 状态：M0-B 已冻结最小交换规则；M1 按本文实现并通过接口自动化测试后才能提供团队联调。
> 适用对象：PixoMosaic Web 与未来 App 对拼豆后端的调用。

## 1. 统一规则

- 业务 API 前缀为 `/api/v1`；Payload Admin 和内部管理接口不直接作为前端业务契约。
- 不要求身份的公开入口也须经过来源、速率与请求体大小检查；需要身份的入口再执行会话和对象归属检查。
- JSON 成功/错误响应携带 `requestId`；认证和二进制下载以 `X-Request-Id` Header 携带同一用途的关联 ID。前端错误展示不得依赖服务器内部错误文本。
- 创建/提交/状态变更接口支持幂等键；重复请求不能重复创建作品、订单、通知或审计事件。
- 列表接口使用明确的分页参数和稳定排序，不默认返回原图、地址或内部备注。
- 时间统一保存 UTC；前端按用户时区展示。

## 2. 身份与会话

- Web 使用 HTTPS、`Secure`、`HttpOnly` 会话 Cookie；CORS 只允许业务方提供的前端来源。
- M1 支持邮箱密码注册/验证/重设与 Google 登录。Google 的本机 OIDC Mock 已验证协议和绑定规则，但真实 Google callback 尚未配置；未验证邮箱不能保存云端作品。
- 未来 App 使用 Bearer Token 方案，当前只预留版本边界，不在 M1 实现客户端。
- 认证失败、重设失败和越权访问返回统一错误类别，不泄露用户是否存在的额外信息。

## 3. 统一错误对象

```json
{
  "error": {
    "code": "WORK_ACCESS_DENIED",
    "message": "无法访问该作品。",
    "requestId": "request-id",
    "details": {}
  }
}
```

`details` 只返回前端可处理的非敏感字段；调试堆栈、数据库错误、对象存储 URL 和凭据不得返回。

## 4. 文件与数据访问

- 原图、图纸 JSON、导出文件默认私有；通过短期授权获取下载地址或流式响应。
- 展示图/缩略图的公开性由作品/帖子状态决定；不能以文件路径猜测权限。
- 上传必须校验 MIME、扩展名、实际文件特征、大小、数量和作品归属；未完成关联的孤儿文件可清理。
- 所有下载、敏感查看、删除、授权变更和后台操作需要审计。

## 5. M1 最小作品接口（实现前冻结）

所有成功响应都含 `requestId`；所有写入请求都须含 `Idempotency-Key`，`PATCH` 同时带 `expectedRevision`。示例省略真实资产 URL、Cookie 和任何密钥。

| 方法与路径 | 用途 | 请求关键字段 | 成功响应关键字段 | 可处理错误码 |
| --- | --- | --- | --- | --- |
| `POST /api/v1/works` | 建立不可见 draft | `title`、初始 `document`、`kind` | `workId`、`state:draft`、`documentRevision:0` | `WORK_LIMIT_REACHED`、`WORK_DOCUMENT_INVALID`、`WORK_DOCUMENT_TOO_LARGE` |
| `POST /api/v1/works/:id/assets/upload-intent` | 申请一次私有直传 | `role`、`mimeType`、`sizeBytes`、`sha256` | `assetId`、短期上传指令、`expiresAt` | `WORK_ACCESS_DENIED`、`ASSET_TYPE_INVALID`、`ASSET_TOO_LARGE`、`ASSET_LIMIT_REACHED` |
| `PUT /api/v1/works/:id/assets/:assetId/upload` | 将二进制写入本机受控目录 | 与 intent 一致的 `Content-Type` 和字节体 | `204` | `ASSET_TOO_LARGE`、`ASSET_TYPE_INVALID`、`ASSET_UPLOAD_EXPIRED`、`ASSET_UPLOAD_CONFLICT` |
| `POST /api/v1/works/:id/assets/confirm` | 校验并确认已上传对象 | `assetId`、`sha256` | 安全 `asset` 投影 | `ASSET_NOT_FOUND`、`ASSET_VALIDATION_FAILED`、`WORK_ACCESS_DENIED` |
| `GET /api/v1/works/:id/assets/:assetId` | 读取本人已确认私有资产 | 无 | 安全二进制响应，不返回路径或公开 URL | `AUTH_REQUIRED`、`ASSET_NOT_FOUND` |
| `PATCH /api/v1/works/:id/document` | 引用已确认资产并激活/更新作品 | `expectedRevision`、完整 `document` | `state:active`、递增后的 `documentRevision`、内容哈希 | `WORK_REVISION_CONFLICT`、`ASSET_NOT_READY`、`WORK_DOCUMENT_INVALID`、`WORK_DOCUMENT_TOO_LARGE` |
| `GET /api/v1/works` | 分页读取自己的 active 作品 | `cursor`、`limit`（1–50） | 安全摘要数组、`nextCursor` | `AUTH_REQUIRED` |
| `GET /api/v1/works/:id` | 读取自己的完整作品快照 | 无 | 安全 Work、Document、Asset 投影 | `WORK_ACCESS_DENIED`、`WORK_NOT_FOUND` |
| `DELETE /api/v1/works/:id/draft` | 用户取消未激活首次保存 | 无 | `state:deleted` | `WORK_ACCESS_DENIED`、`WORK_NOT_DRAFT` |
| `POST /api/v1/works/:id/deletion-request` | 软删除 active 作品 | `expectedRevision` | `state:pending_deletion`、`recoverableUntil` | `WORK_ACCESS_DENIED`、`WORK_REVISION_CONFLICT` |

## 5.1 M1.1 个人豆仓接口（已冻结并完成本机验证）

个人豆仓是 M1 的受控扩展，详细数据和事务规则以 `../specs/02e-M1.1-个人豆仓与制作扣减-spec.md` 为准。所有写入使用当前活动会话、可信 Origin 和 `Idempotency-Key`；服务端不接受 `ownerId` 或前端计算的图纸用量。

| 方法与路径 | 用途 | 请求关键字段 | 成功响应关键字段 | 可处理错误码 |
| --- | --- | --- | --- | --- |
| `GET /api/v1/inventory` | 读取自己的库存余额 | `beadSizeMm`、`query`、`health`、分页 | 余额、规格、HEX、版本、健康度 | `AUTH_REQUIRED` |
| `POST /api/v1/inventory/adjustments` | 入库、手动扣减或盘点 | `kind`、规格、颜色、数量或 `targetQuantity`、`expectedRevision` | 操作、余额和明细投影 | `INVENTORY_REVISION_CONFLICT`、`INVENTORY_INPUT_INVALID` |
| `GET /api/v1/inventory/operations` | 读取自己的库存操作历史 | 分页 | 操作头与明细安全投影 | `AUTH_REQUIRED` |
| `DELETE /api/v1/inventory/operations/:id` | 软删原操作并生成唯一反向回滚 | 可选删除原因 | 原操作状态、回滚操作和余额 | `INVENTORY_OPERATION_NOT_FOUND`、`INVENTORY_OPERATION_NOT_REVERSIBLE` |
| `GET /api/v1/works/:id/inventory-status` | 按服务端作品快照读取库存状态 | 无 | 每色需求、库存、缺口、健康度和汇总 | `WORK_BEAD_SIZE_REQUIRED`、`WORK_NOT_FOUND` |
| `POST /api/v1/works/:id/complete` | 确认完成一份作品并原子扣减 | 可选备注 | 制作操作和扣减结果 | `WORK_BEAD_SIZE_REQUIRED`、`WORK_NOT_FOUND` |
| `GET /api/v1/inventory/template` | 下载 CSV 模板 | 无 | CSV 文件 | `AUTH_REQUIRED` |
| `POST /api/v1/inventory/imports/preview` | 服务端预检 CSV | 规格、色号系统、策略、文件 | 冻结预览、行级问题和过期时间 | `INVENTORY_IMPORT_INVALID` |
| `POST /api/v1/inventory/imports/commit` | 提交已确认预览 | `previewId`、预览哈希 | 导入操作和余额投影 | `INVENTORY_IMPORT_EXPIRED`、`INVENTORY_IMPORT_CHANGED` |
| `GET /api/v1/works/:id/inventory-shortages` | 导出当前作品缺货清单 | 显示色号系统 | CSV 或安全 JSON 投影 | `WORK_BEAD_SIZE_REQUIRED`、`WORK_NOT_FOUND` |

实现前不承诺 Excel/XLSX 导入；第一版只支持 CSV。美国品牌色号映射也必须在品牌、版本和可追溯来源确认后，才增加到预检可选项。

一次首次保存的完整时序、资产角色与失败清理规则以 `M1-作品数据契约.md` 第 9 节为准。业务 API 不调用 Payload 默认 REST 或 GraphQL 路由。

### 当前本地实现状态（2026-08-22）

- 已实现：`POST /api/v1/works` 的 `pattern` 与不含 `assetId` 的 `board` draft。请求必须来自可信来源、带登录会话和 `Idempotency-Key`；服务端校验矩阵、透明格、色值、统计、画板图层/坐标/重叠/替换规则与 8 MiB 容量，以单一事务写入 draft Work、revision 0 WorkDocument 与持久化幂等结果。
- 已实现：`GET /api/v1/works` 和 `GET /api/v1/works/:id`。它们只返回当前已验证 active 用户自己的 active 作品；草稿、其他用户作品与内部数字 ID 均不暴露。
- 已实现：规范路径 `PATCH /api/v1/works/:id/document` 的 `pattern` 与 `board` v1 子集。它会创建不可变的新快照，将 draft 激活为 active 或更新 active 作品，并以 `expectedRevision`、数据库条件更新和触发器共同阻止覆盖式并发写入；同一幂等键重试不重复创建快照。材料清单若为 `generated`，必须指向保存后的新修订号。每个用户最多 50 个 active 作品，数据库拒绝第 51 次激活且整个事务回滚。旧的 `PATCH /api/v1/works/:id` 仅为本地早期调用保留兼容，前端新实现必须使用规范路径。
- 已实现：业务路由独立 CORS/CSRF 来源校验、`requestId`、稳定错误对象和 `Idempotency-Key` 的预检放行；本地环境只补自身 `AUTH_BASE_URL` 来源，team-test/生产仍必须显式配置白名单。
- 已实现：受控文件的 `upload-intent → PUT → confirm → GET` 本地闭环。仅本人可读 ready 状态 PNG/JPEG/WebP；服务端以限长分块读取、文件特征、Sharp 解码、声明 MIME、尺寸与 SHA-256 交叉验证，限制为单文件 15 MiB、每作品 10 张/100 MiB、每用户 2 GiB。文件存于项目内、Git/Docker 忽略的私有替身目录；读取带 `Content-Disposition: attachment` 和 `X-Content-Type-Options: nosniff`，不返回存储键、绝对路径或公开 URL。过期 `upload_pending` / `uploaded` 和失败资产可由 `pnpm cleanup:assets` 删除。
- 已实现：`DELETE /api/v1/works/:id/draft` 会立即隐藏未激活草稿；`POST /api/v1/works/:id/deletion-request` 要求 `expectedRevision`，将 active 作品隐藏并设置 30 天 `recoverableUntil`。本机 `pnpm cleanup:works` 按对象文件、WorkAsset、WorkDocument、Work 顺序回收已到期记录。
- 已实现：`board.layers[].sourceAssetId` 只允许引用本用户、当前作品且 `ready` 的 `original` 资产；`thumbnailAssetId` 只允许同一边界的 `thumbnail` 或 `display` 资产。跨用户、跨作品、未确认、错误角色或不存在的引用统一返回 `ASSET_NOT_READY`，且不会激活 draft 或留下新快照。
- 已实现：认证继续复用 Better Auth 的数据库限流与单账号失败锁定；业务 API 新增按活动用户的原子 PostgreSQL 桶，在解析 JSON/二进制前限制作品写入、上传 intent/PUT/confirm 与私有下载，命中时返回 `429 RATE_LIMITED` 和 `Retry-After`。关键认证、作品和私有文件动作写入最小审计事件，且不记录邮箱、Token、文件内容、存储键、IP 或完整 URL；完整初始阈值和保留期见 `../specs/02b-M1-审计与反滥用-spec.md`。
- 已实现：Google 的本机 OIDC Mock 验证授权码、PKCE、state、nonce、ID Token 签名、issuer、audience、`email_verified` 和显式账号绑定。默认运行时关闭 Google provider；不保存真实凭据，不配置真实 callback。细则见 `../specs/02c-M1-Google本地OIDC-Mock-spec.md`。
- 已实现：M1.1 个人豆仓余额、手工调整、操作历史/删除回滚、服务端作品库存状态和完成制作扣减；CSV 模板、UTF-8 CSV 服务端预检/10 分钟冻结确认导入、以及缺货 CSV 导出。预检拒绝未知、歧义、重复色号与非法数量；确认会复核预览哈希和受影响余额 revision，防止覆盖另一设备的新库存。Excel/XLSX 与美国品牌色表仍未实现。
- 未实现：`pattern` 的资产引用字段尚未在冻结契约中定义，当前保持拒绝；真实前端联调。

## 6. 版本与兼容

- 破坏性字段变更新增 API 版本或兼容读取窗口，不覆盖旧作品。
- `WorkDocument.schemaVersion` 与 API 版本独立：API 可以保持 v1，同时支持多个文档版本读取。
- 前端联调需记录前端版本、接口版本、测试环境和验收样例。

## 7. M0 已冻结与仍待业务方确认的内容

- 已冻结：业务前缀、作品最小接口、幂等键位置、文档容量、分页上限、错误处理形态。
- 已确认主域名为 `pixomosaic.com`；`api-test.pixomosaic.com` 的 CNAME 当前不创建，待本地功能通过、Railway 分配实际域名且业务方再次确认后才添加。
- 仍待部署前确认：CORS 来源、Cookie 域、会话过期与重设策略；真实 Google OAuth client、实际回调 URI 与部署凭据；具体速率限制阈值、team-test 预算上限与测试邮箱白名单。

具体准备动作和“现在不用购买什么”见 `../实施准备/M0-本机环境与云端账号清单.md`。
