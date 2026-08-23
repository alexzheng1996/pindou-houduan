# Spec：M1 本地受控文件存储

> 状态：本地实现并验证完成。本 Spec 只覆盖 M1 本地验证所需的最小文件闭环；不创建 R2、MinIO、Railway 或其他云资源。未来 team-test/生产以同一业务契约接入私有 R2/S3，不把本机目录当作部署方案。

## 1. 目标与不做事项

目标是让已验证的活动用户可为自己的私密作品上传并确认一张受控图片，并能在本人身份下下载。后端必须验证文件的真实类型、大小和 SHA-256，而不是相信浏览器提交的 MIME 或文件名。

本阶段不做：画板资产引用、导出生成、真实 S3/R2 直传、公开 CDN URL、SVG/GIF/HEIC 支持、病毒扫描、图片转码、团队环境或真实前端联调。文件下载只用于后端自动化验证，不能被前端当作永久 URL。

## 2. 复用判断

| 候选 | 结论 | 原因 |
| --- | --- | --- |
| 项目既有 Payload `WorkAsset` 模型与官方未来 S3/R2 路线 | 复用 | 已有私有资产元数据、归属与迁移边界；将来替换对象存储无需改业务数据。 |
| `file-type` + 项目已有 `sharp` | 复用 | 用文件特征和图片解码校验真实类型，不以扩展名或请求 Header 作为依据。 |
| MinIO 本地服务 | 不采用 | MinIO 的 AGPL-3.0 许可证和额外服务运维不适合当前仅验证本地流程的阶段。 |
| LocalStack | 不采用 | 需要额外容器和 AWS 模拟面，许可证标记/维护边界不适合当前最小范围。 |
| 直接使用应用磁盘作为长期生产存储 | 不采用 | Docker/Railway 容器的本地磁盘不可靠，且无法满足未来私有对象存储与回收边界。 |

选择：在项目内、Git 忽略的 `src/service/data/local-object-store/` 使用受控本地适配层；该目录只允许本机测试数据，清理与测试都不得越出项目目录。

## 3. 支持范围与限额

- 角色仅开放 `original`、`display`、`thumbnail`；其余 `document`、`export` 保留给后续生成流程。
- 仅接受 `image/png`、`image/jpeg`、`image/webp`；明确拒绝 SVG、GIF、伪造图片和任意可执行文件。
- 单文件为 1 B–15 MiB；每个作品最多 10 个图片资产、图片资产合计最多 100 MiB；每位用户所有未删除图片资产合计最多 2 GiB。
- 解码后图片最大 4,000 万像素；不保存原始文件名，下载统一使用服务端生成的 `assetId`。
- 资产状态：`upload_pending → uploaded → ready`；类型、哈希或大小异常为 `validation_failed`，不可被作品文档引用。

## 4. 接口与时序

| 接口 | 用途 | 关键输入 | 成功输出 |
| --- | --- | --- | --- |
| `POST /api/v1/works/:id/assets/upload-intent` | 预留私有图片槽位 | `role`、`mimeType`、`sizeBytes`、`sha256`、`Idempotency-Key` | 安全 `asset`、15 分钟内有效的同源 `PUT` 地址 |
| `PUT /api/v1/works/:id/assets/:assetId/upload` | 上传二进制图片 | 与 intent 一致的 Content-Type 和文件体 | `204`；同一已上传 asset 的网络重试同样返回 `204` |
| `POST /api/v1/works/:id/assets/confirm` | 再核对本地对象并置为 ready | `assetId`、`sha256`、`Idempotency-Key` | 安全 `asset` 投影 |
| `GET /api/v1/works/:id/assets/:assetId` | 私有读取验证 | 无 | 私有文件流；仅当前 owner 可读 |

```text
1. 创建 draft Work（已实现）
2. 申请 upload-intent，事务中预留数量/空间
3. 在可信 Origin + 当前会话下 PUT 二进制文件
4. 后端以限长分块读取，验证大小/SHA-256/文件特征/图片解码，写入受控目录
5. confirm 再读取核对，资产变为 ready
6. 仅 ready 资产可由本人下载；后续 WorkDocument 才可引用该 assetId
```

`upload-intent`、`confirm` 使用持久化幂等记录。`PUT` 不创建新的业务对象，且已上传同一 asset 的重试不覆写文件。所有写接口要求已验证活动会话、可信 Origin；URL、资产 ID、前端 `userId` 或 MIME Header 不能单独构成授权。

## 5. 安全、失败与清理

- 永不返回 `storageKey`、本机绝对路径、对象存储凭据或永久公开 URL。
- 文件先限长读入并完整校验，后原子写入；数据库写失败时删除本次写入对象。当前为 15 MiB 上限内的内存校验，不把它误称为边读边写的对象存储流式上传。存储目录路径由服务端从 owner/work/assetId 生成，并做目录逃逸检查。
- 上传超过 intent 的大小、哈希不匹配、MIME 不匹配或解码失败时返回非敏感错误并标为 `validation_failed`；无效对象不保留。
- `confirm` 不允许把 `upload_pending`、`validation_failed`、其他用户或其他作品的 asset 变成 `ready`。
- 本地清理任务会删除：已过期的 `upload_pending` 或 `uploaded` intent、失败/未关联资产、没有元数据引用的对象，以及已进入作品物理回收的对象。清理服务必须按 storage object → WorkAsset → WorkDocument → Work 的顺序执行；`pnpm cleanup:works` 已实现到期作品的对象、资产、快照和作品元数据回收。
- 本地对象目录与测试生成的图片均被 Git 忽略；Docker 镜像不复制该目录。team-test/生产必须改用私有 R2/S3 桶及短期签名授权。

## 6. 验收标准

- 已验证用户能完成 PNG/JPEG/WebP 的 intent、上传、confirm 和私有读取；响应不泄露内部路径或存储键。
- 用户 B、未登录、未知 Origin 不能申请、上传、确认或读取用户 A 的资产。
- SVG、伪造 MIME、错误 SHA-256、错误大小、超过 15 MiB、超过作品数量/容量上限均被拒绝；失败后不留可读取对象。
- 同幂等键的 intent/confirm 不重复创建资产；重复 `PUT` 不覆写已存对象。
- 至少有自动化测试覆盖成功流程、A/B 隔离、文件特征校验、限额、幂等和孤儿清理；通过后才允许在 `PATCH /document` 中开放 assetId 引用。
