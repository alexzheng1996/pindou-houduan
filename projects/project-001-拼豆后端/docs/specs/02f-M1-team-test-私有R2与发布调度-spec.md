# Spec：M1 team-test 私有 R2、受控发布与清理调度

> 状态：待用户审阅，已于 2026-08-24 根据部署可执行性复核修订。本 Spec 只定义让已完成的本机 M1 文件能力安全进入邀请制 team-test 的最小改造与验收门禁。它不授权创建 Cloudflare R2、Neon、Railway、Resend、Google OAuth、DNS 或任何真实凭据，也不改变 M2 范围。

## 1. 结论与业务目标

推荐采用 **后端受控私有 R2 + 单实例受控迁移 + 独立清理任务**。

- 用户继续调用已有的同源后端文件接口；浏览器不直接持有 R2 凭据、不获得永久对象 URL，也不需要配置 R2 CORS。
- 应用以 `Buffer` 在内存中完成既有的 15 MiB 限长读取、真实图片类型、像素、大小与 SHA-256 校验；校验通过后才由后端写入私有 R2。M1 不做流式或分段上传，并以并发上限保持内存可控。
- 发布时先对新 Neon 数据库运行显式迁移，成功后才启动 Web 服务；不会恢复 Payload schema push，也不会让多个副本竞争迁移。
- 文件、作品、安全记录和库存导入预览由一个短时、可观察、可重试的清理命令顺序处理；失败不会删除数据库记录来掩盖对象存储失败。

业务结果是：team-test 可以验证真实私有文件、跨设备读取、删除回收和邮件/OAuth，而不把用户文件放在 Railway 临时磁盘，也不扩大浏览器权限。

## 2. 范围与不做事项

### 本次范围

1. 在 `local` 与 `team-test` 间切换的私有对象存储适配层。
2. R2 的写入、读取、存在检查和删除；保持现有 WorkAsset、owner、配额、状态机和 API 响应不变。
3. team-test 启动前环境变量的 fail-closed 校验。
4. 单实例迁移发布流程与单一清理命令的部署调度说明。
5. 无真实 R2 凭据的适配层自动化测试、最终 Docker 镜像复核，以及真实资源创建后的独立验收清单。

### 明确不做

- 不创建 R2 桶、API Token、Neon/Railway/Resend/Google 项目或 DNS 记录。
- 不实现浏览器直传、预签名上传/下载 URL、公开桶、公共 CDN、自定义对象域、对象 ACL、SSE-C（客户自管密钥）、生命周期标签或跨桶复制。
- 不放宽现有 `PUT` 路由的会话、Origin、owner、限额、哈希或图片校验。
- 不把上传改成超过 15 MiB 的多段流式上传；M1 继续使用校验后的单对象写入。
- 不把 team-test 当作生产；不处理多区域、高可用、病毒扫描、转码、导出生成或 M2 社区文件。

## 3. 复用优先评估

| 候选 | 结论 | 复用部分 | 不引入/原因 |
| --- | --- | --- | --- |
| 项目既有 `WorkAsset`、文件校验、同源 API 和本地存储适配器 | 直接复用 | owner/work/asset 归属、对象键生成、限制、幂等、状态机、删除顺序和 API 契约 | 不复制本机目录实现到 team-test；非 `local` 不能回退到应用磁盘 |
| AWS SDK v3 `@aws-sdk/client-s3`（Apache-2.0） | 推荐新增 | 标准 S3 `PutObject`、`GetObject`、`HeadObject`、`DeleteObject` 对接 R2 endpoint | 不引入 `@aws-sdk/lib-storage`：15 MiB 单对象不需要 multipart；不引入 presigner：浏览器不直连 |
| Cloudflare R2 S3 兼容 API | 推荐目标服务 | R2 支持 `PutObject`、`GetObject`、`HeadObject`、`DeleteObject` 与条件操作 | 不使用 R2 公共访问、对象 ACL、Bucket Lifecycle API 或对象标签；这些不是 M1 必需且部分 S3 特性不兼容 |
| Cloudflare Worker / 浏览器直传 R2 | 不采用 | 无 | 会增加签名 URL、R2 CORS、临时授权、失效处理和前端安全面，超过当前 team-test 所需 |
| MinIO/LocalStack | 不采用 | 无 | 要新增服务与维护面；本地闭环已经通过，不能用额外模拟环境替代真实 R2 验收 |

官方依据：

- [R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)：本次所需的 Put/Get/Head/Delete 和条件操作受支持。
- [AWS SDK S3 client](https://www.npmjs.com/package/@aws-sdk/client-s3)：采用官方 S3 客户端，不自行实现签名协议。
- [Railway plans](https://docs.railway.com/pricing/plans) 与 [cost control](https://docs.railway.com/pricing/cost-control)：运行资源按量收费，硬上限会停止 workloads。

## 4. 架构与接口边界

```text
浏览器（Cookie + 可信 Origin）
  │  既有 /api/v1/works/:id/assets/*
  ▼
文件业务服务
  ├─ 鉴权、owner、限流、容量、哈希、图片解码、审计
  └─ 私有对象存储端口
       ├─ local：项目内 local-object-store（仅 APP_ENV=local）
       └─ team-test：R2 S3 Client（仅 APP_ENV=team-test）
             └─ 私有 team-test 桶
```

### 4.1 不变的外部 API

以下接口、请求和成功/失败语义不改：

| 接口 | team-test 行为 |
| --- | --- |
| `POST /api/v1/works/:id/assets/upload-intent` | 创建相同的私有资产预留，返回已有同源 PUT 路径；不返回 R2 URL、桶名或对象键。 |
| `PUT /api/v1/works/:id/assets/:assetId/upload` | 后端读取并校验字节后，使用 R2 原子条件写入；已成功的相同重试仍返回 `204`，不同内容返回 `409`。 |
| `POST /api/v1/works/:id/assets/confirm` | 后端从 R2 读取并再次校验后置为 `ready`；不会相信浏览器声称的上传状态。 |
| `GET /api/v1/works/:id/assets/:assetId` | 后端仅以已校验的 `Buffer` 向 owner 返回 ready 文件；不重定向到 R2。 |

数据库 `storageKey` 继续是服务端内部字段；其值只按既有 `owner/work/asset` 生成，禁止从 URL、请求体或前端状态传入。

### 4.2 对象写入与删除语义

1. `PUT` 先通过现有 `Buffer` 字节校验，再调用 `PutObject`，必须使用 `If-None-Match: *` 条件写入，禁止覆盖。
2. 若 R2 报“对象已存在”，后端读取既有对象并比较 SHA-256；相同内容视为安全重试并补齐资产状态，不同内容为 `ASSET_UPLOAD_CONFLICT`。
3. 若 R2 写入成功但数据库更新/审计提交失败，立即尽力删除该对象。删除成功时，既有 `upload_pending` 元数据仍按上传到期规则回收；删除失败且数据库可用时写入既有 `orphaned` 状态与 `purgeAfter`，由清理命令重试。数据库暂不可用时，不假造成功：确定性 `storageKey` 与尚未到期的资产记录使后续同内容重试可恢复，过期清理可再次删除对象。
4. R2 网络超时或结果未知时，后端不得重试覆盖；以相同 `storageKey` 执行条件写入/读取哈希判定。相同内容恢复为成功，不同内容拒绝，无法读取时返回非敏感可重试错误。
5. `confirm` 与 `GET` 均须从对象存储真实读取；读取缺失、大小/哈希/类型不符时按既有非敏感错误拒绝，并把资产置为可回收失败状态。
6. 清理和作品物理回收固定按 **对象 → WorkAsset → WorkDocument → Work** 顺序。对象删除失败时停止该条元数据删除，留待下次任务重试。

R2 不配置 ACL、Bucket Lifecycle、对象标签、SSE-C 或公开 URL；本 Spec 不改变 R2 平台自身静态加密能力。私有性由桶设置、最小权限密钥与后端鉴权共同保证。

## 5. 配置与密钥边界

### 5.1 新增运行时变量

本机固定拓扑为：后端 API `http://127.0.0.1:3002`，PixoMosaic 单图/画板来源分别为 `http://127.0.0.1:3050` / `http://127.0.0.1:3100`。`3000` 不属于本项目端口。Railway 使用平台注入的动态 `PORT`，不继承本机 `3002`。

运行时只接受 `APP_ENV=local` 或 `APP_ENV=team-test`。本机可默认 `local`；Docker runner 的默认值必须是非法哨兵值，因此 Railway 未显式设置 `APP_ENV=team-test` 时进程立即退出，不能降级为 local。仅当 `APP_ENV=team-test` 且对象存储模式为 R2 时，下列变量必须同时存在；任何一项缺失、bucket 名非法或模式与环境不匹配，进程必须在启动前失败：

```text
OBJECT_STORAGE_MODE=r2
R2_ACCOUNT_ID
R2_BUCKET
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_REGION=auto
```

- R2 endpoint 只由 `R2_ACCOUNT_ID` 在代码中推导为 Cloudflare 官方 S3 endpoint；不保留可任意填写的 `R2_ENDPOINT`，防止误把私有文件发至未知 S3 服务。
- 值只写在 Railway 的受保护变量中；`.env.example` 只保留变量名和占位说明；严禁写入 Git、日志、错误响应、审计或测试夹具。
- `APP_ENV=local` 强制 `OBJECT_STORAGE_MODE=local`（未填写时仅 local 可默认）；`team-test` 强制 `r2`；其他环境值一律拒绝启动。
- `PIXOMOSAIC_BUILD_PHASE` 只允许 Docker builder 使用，runner 与 Railway 不设置。

### 5.2 R2 桶与权限（待业务方创建时执行）

- 一个独立、私有的 team-test Standard 桶；不与 local/production 共用，不开启 public access 或自定义 public domain。
- 使用专属最小权限 R2 API Token：仅该 team-test 桶的 **Object Read & Write**；不授予账户级管理、DNS、账单、其他桶或公开访问权限。
- 对象名继续为服务端生成的 `objects/<owner-id>/<work-public-id>/<asset-public-id>`。这是内部路径，不可被 API、日志或下载文件名回显。
- 桶的地理位置仅按 Cloudflare 当日可选项配置；APAC 是位置提示，不承诺“必在新加坡”。

## 6. 受控发布与调度

### 6.1 迁移发布

1. CI/本机构建最终 Docker 镜像，确认镜像没有 `.env`、本机对象目录、数据库数据或开发 `.next-*`。
2. Railway 的 **Pre-deploy Command** 固定为最终应用镜像内可执行的 `pnpm migrate`；实施必须让 runner 包含该命令、迁移源码与运行所需依赖，并在 Docker 验证中实际执行，不能只在 builder 镜像或开发机可用。
3. Pre-deploy 使用同一组受保护变量，且只允许一个实例；退出码 `0` 才可发布 Web，非 `0` 时 Railway 不发布。不得依赖正在运行的 Web、数据卷或本机文件。
4. 对新 Neon 数据库运行当前部署镜像包含的**全部**受控迁移；记录镜像版本与本次迁移清单。`payload.config.ts` 继续 `push: false`，绝不使用 schema push。
5. 任务成功后才启动一个 Web 副本；Railway `/health` 检查使用平台动态 `PORT`。Docker 本地默认端口为 `3002`，但其健康检查同样读取运行期 `PORT`。
6. 迁移失败：不启动或立即停止 Web 服务；保存脱敏日志，修正后以新镜像重试。不得在有 team-test 数据的库上随意执行 down/reset。

当前 standalone Docker runner 不包含 `pnpm` CLI、迁移源码或显式入口；实施必须补齐最终应用镜像的迁移能力，不能假设 `node server.js` 会执行迁移，也不能用仅存在于 builder 的独立 target 冒充 Railway Pre-deploy 可执行条件。

### 6.2 清理任务

| 任务 | 命令/业务函数 | 初始频率 | 成功证据 | 失败处理 |
| --- | --- | --- | --- | --- |
| team-test 顺序清理 | `cleanup:team-test`：assets → works → security → inventory-imports | `17 * * * *`（UTC，每小时） | 四类任务各自的删除数/失败数与总退出码 | 每类最多一次；任一失败保留原数据、继续尝试其余类，最终以非 `0` 退出，下一轮重试 |

初期只建立一个 Railway Cron service，Start Command 为最终镜像内可执行的 `pnpm cleanup:team-test`，使用上述 UTC 表达式。任务必须在完成后关闭数据库连接并退出；上一次仍在运行时 Railway 会跳过下一次，因此单次运行需短于一小时且在 3 分钟内完成，否则以日志和非 `0` 作为失败信号。禁止在 Web 请求、前端定时器或多个 Web 副本中隐式执行清理。平台没有可用 Cron 或该命令无法在最终镜像执行时，不创建完整 team-test，须先选择并获批等效调度方案。

## 7. 自动化测试与验收门禁

### 7.1 无真实云资源的实现前验证

- 运行时配置单测：只接受 `local/team-test`；Docker 默认哨兵环境拒绝启动；local 不能误用 R2；team-test 缺任一 R2 变量或仍为 `local` 模式均拒绝启动；测试不得包含真实密钥。
- 用一个内存/命令桩实现对象存储端口测试：条件写入、同内容重试、冲突、读取缺失、删除失败、对象写入成功/数据库失败、网络结果未知后的恢复与清理顺序均可重复断言。
- 现有 M1 资产流、A/B 隔离、容量、幂等、审计、作品回收测试必须保持通过；新增适配不能改 API 响应形态。
- Node 24 下通过 `pnpm lint`、`pnpm test`、`pnpm build`、`pnpm audit --prod --audit-level=high` 与 `git diff --check`。
- 构建 Docker 镜像并检查：构建上下文不含 `.next-*`、`node_modules`、`.env`、本机数据或 Cookie；runtime 镜像不含这些文件。还须证明最终镜像可运行迁移与 `cleanup:team-test`，且 `PORT=3002` 与自定义 `PORT` 的 `/health` 均可用。当前准备镜像验证的 context 为约 8.87 KB、镜像约 77.7 MB；实施后需重新验证，不把该数字当作固定承诺。

### 7.2 创建资源后（另行授权）的真实 team-test 验收

1. 新 Neon 数据库中当前部署镜像包含的全部迁移均已执行，并记录镜像版本与迁移清单；Web 服务在 Railway 实际 `PORT` 的 `/health` 返回 200。
2. 白名单用户 A 上传 PNG、confirm、下载；R2 桶内对象保持私有，响应、审计、日志均不出现对象键或 R2 凭据。
3. 用户 B、未登录、未知 Origin 不能上传、确认、下载或猜测读取 A 的文件。
4. 同 asset 同内容上传重试是 `204`；不同内容是 `409`；超量、错哈希、伪造 MIME 和图像解码失败不留下可读取对象。
5. 有意制造一条过期/失败资产和一条到期作品，分别确认清理任务依顺序回收，并留最小审计证据。
6. 在 HTTPS、实际 CORS/CSRF、`COOKIE_SECURE=true` 下完成注册、邮件、保存、上传、下载、库存与 A/B 隔离闭环。
7. 只有以上通过，才把 M1 标为 team-test 技术 Go；真实 Google OAuth 单独作为可选门禁，不阻塞邮箱路径。

## 8. 回滚、成本与业务 Go

- 代码发布失败：回滚到上一可运行镜像；不自动回滚已成功的数据库迁移。迁移回滚须由开发者评估数据状态并获业务方授权。
- 发现对象权限或费用异常：立即暂停 Railway Web/清理任务、移除注册入口、撤销 R2 最小权限密钥；不删除桶或数据库，直到业务方明确授权停止/删除。
- R2 Standard 免费层、Neon Free、Resend Free 和 Railway 价格须在开户日复核。Railway Hobby 的订阅起步为 $5/月，但常驻 CPU/内存可能超过包含额度；$10 硬上限达到时会停止工作负载。
- 本 Spec 实现通过后，仍必须由业务方确认：月度预算上限、Railway 单管理员或 Pro 团队协作、区域、R2 桶创建、测试发件域/DNS、唯一邮件 override 收件箱、注册白名单、Railway 实际域名后的 CNAME，以及是否启用真实 Google OAuth。

## 9. 交接输出

实施完成后应交付：

1. R2 适配器、配置门禁与无凭据自动化测试；
2. 最终 Docker 镜像、迁移 runner 和清理任务的可复现命令；
3. team-test 变量**名称**和最小权限清单（不含值）；
4. 按日复核的费用/预算/停止方案；
5. 创建资源后可逐项填写的 team-test 验收记录与回滚证据。
