# API v1 总则

> 状态：M0-B 已冻结最小交换规则；M1 按本文实现并通过接口自动化测试后才能提供团队联调。
> 适用对象：PixoMosaic Web 与未来 App 对拼豆后端的调用。

## 1. 统一规则

- 业务 API 前缀为 `/api/v1`；Payload Admin 和内部管理接口不直接作为前端业务契约。
- 不要求身份的公开入口也须经过来源、速率与请求体大小检查；需要身份的入口再执行会话和对象归属检查。
- 所有响应携带 `requestId`；前端错误展示不得依赖服务器内部错误文本。
- 创建/提交/状态变更接口支持幂等键；重复请求不能重复创建作品、订单、通知或审计事件。
- 列表接口使用明确的分页参数和稳定排序，不默认返回原图、地址或内部备注。
- 时间统一保存 UTC；前端按用户时区展示。

## 2. 身份与会话

- Web 使用 HTTPS、`Secure`、`HttpOnly` 会话 Cookie；CORS 只允许业务方提供的前端来源。
- M1 支持邮箱密码注册/验证/重设与 Google 登录；未验证邮箱不能保存云端作品。
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
| `POST /api/v1/works/:id/assets/confirm` | 校验并确认已上传对象 | `assetId`、`sha256` | 安全 `asset` 投影 | `ASSET_NOT_FOUND`、`ASSET_VALIDATION_FAILED`、`WORK_ACCESS_DENIED` |
| `PATCH /api/v1/works/:id/document` | 引用已确认资产并激活/更新作品 | `expectedRevision`、完整 `document` | `state:active`、递增后的 `documentRevision`、内容哈希 | `WORK_REVISION_CONFLICT`、`ASSET_NOT_READY`、`WORK_DOCUMENT_INVALID`、`WORK_DOCUMENT_TOO_LARGE` |
| `GET /api/v1/works` | 分页读取自己的 active 作品 | `cursor`、`limit`（1–50） | 安全摘要数组、`nextCursor` | `AUTH_REQUIRED` |
| `GET /api/v1/works/:id` | 读取自己的完整作品快照 | 无 | 安全 Work、Document、Asset 投影 | `WORK_ACCESS_DENIED`、`WORK_NOT_FOUND` |
| `DELETE /api/v1/works/:id/draft` | 用户取消未激活首次保存 | 无 | `state:deleted` | `WORK_ACCESS_DENIED`、`WORK_NOT_DRAFT` |
| `POST /api/v1/works/:id/deletion-request` | 软删除 active 作品 | `expectedRevision` | `state:pending_deletion`、`recoverableUntil` | `WORK_ACCESS_DENIED`、`WORK_REVISION_CONFLICT` |

一次首次保存的完整时序、资产角色与失败清理规则以 `M1-作品数据契约.md` 第 9 节为准。业务 API 不调用 Payload 默认 REST 或 GraphQL 路由。

## 6. 版本与兼容

- 破坏性字段变更新增 API 版本或兼容读取窗口，不覆盖旧作品。
- `WorkDocument.schemaVersion` 与 API 版本独立：API 可以保持 v1，同时支持多个文档版本读取。
- 前端联调需记录前端版本、接口版本、测试环境和验收样例。

## 7. M0 已冻结与仍待业务方确认的内容

- 已冻结：业务前缀、作品最小接口、幂等键位置、文档容量、分页上限、错误处理形态。
- 仍待业务方确认：API 域名和团队测试域名；CORS 来源、Cookie 域、会话过期与重设策略；认证 Google OAuth 的回调方式和账号绑定规则；具体速率限制阈值。

具体准备动作和“现在不用购买什么”见 `../实施准备/M0-本机环境与云端账号清单.md`。
