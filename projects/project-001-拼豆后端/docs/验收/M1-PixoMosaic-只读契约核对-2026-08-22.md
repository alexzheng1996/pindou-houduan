# M1 PixoMosaic 只读契约核对（2026-08-22）

> 目的：在不修改前端仓库的前提下，确认现有 PixoMosaic 数据语义能否映射到 M1 `WorkDocument v1`，并列出首次真实联调必须完成的前端工作。本记录不等同于真实浏览器往返验收。

## 结论

- **`pattern` 与 `board` 的核心可编辑数据可映射到后端 v1**：格点矩阵、尺寸、统计、图层、叠放、稀疏画板编辑、色彩替换和生成参数均已有对应语义。
- **当前前端尚未接入后端业务 API**：检索到的 `fetch` 仅用于前端自身 `/api/board-draft`；未发现 `/api/v1/works`、文件上传、鉴权 Cookie 调用或 `Idempotency-Key` 客户端。因此现在不能称为“前后端联调完成”。
- **不能直接上传现有浏览器对象**：前端的 IndexedDB ID、Data URL、草稿外层 `version/revision`、临时编辑会话和 `/api/board-draft` 都不是云端契约。必须经一个明确的前端适配层转换后再主动保存。
- **现有 M1 后端不扩展 `pattern` 资产字段**：它没有冻结的资产引用字段；前端可先只保存其可编辑 JSON。若业务需要跨设备恢复原图/缩略图，需先确认兼容设计，不能临时增加 `assetId`。

## 本次只读范围

| 项目 | 证据 |
| --- | --- |
| 前端仓库状态 | `/Users/alexwork/Documents/PixoMosaic`，只读核对时为 `codex/board-layout-cleanup`，基线提交 `c6a4b04`。仓库已有未跟踪的 `docs/superpowers/specs/2026-08-18-personal-bead-warehouse-design.md` 与 `tmp/`，本次未触碰。 |
| 单图本地库 | `src/utils/localAssetLibrary.ts` 的 `SavedPatternAsset`，浏览器 IndexedDB 表 `perlerBeadsLocalAssetLibrary/patterns`。 |
| 画板草稿 | `src/utils/boardDraftStorage.ts`、`src/types/boardTypes.ts`、`src/utils/boardComposer.ts`，本地草稿当前版本为 4。 |
| 当前前端临时 API | `src/app/api/board-draft/route.ts`，是同一前端服务中的文件型草稿存储，非 M1 后端。 |
| 后端目标契约 | `docs/接口/M1-作品数据契约.md`、`docs/接口/API-v1-总则.md`。 |

## 字段映射

### 单图 `pattern`

| 前端现有字段 | M1 v1 字段/动作 | 结论 |
| --- | --- | --- |
| `name` | 顶层 `title` | 可直接映射，前端仍须限制在 1–120 字符。 |
| `mappedPixelData` | `pattern.mappedPixelData` | 可映射；保持 row/column 顺序。 |
| `gridDimensions.{N,M}` | `pattern.gridDimensions.{columns,rows}` | 需改名：`N → columns`，`M → rows`。 |
| `colorCounts`、`totalBeadCount` | 同名字段 | 可提交，但后端重算并拒绝不一致数据。 |
| `settings` | 顶层 `settings` | 字段语义大体匹配；转换时保留已定义参数，未知历史字段只能进入已约定的 `legacy`，不能静默丢失。 |
| `MappedPixel.skipColorReplacement` | 不适用于 pattern | 不应上传。它仅是画板顶层编辑的前端内部标记。 |
| `id`、`createdAt`、`updatedAt` | 不上传 | 浏览器本地库元数据；云端使用后端 `workId`、`createdAt`、`updatedAt`。 |
| `originalImageSrc`、`thumbnailDataUrl` | 当前 v1 不上传 | 均为 Data URL 或前端本地资源；不得内嵌 JSON。跨设备保留原图需要后续确认兼容字段后走受控上传。 |

### 画板 `board`

| 前端现有字段 | M1 v1 字段/动作 | 结论 |
| --- | --- | --- |
| `size`、`overlapMode`、`beadSizeMm`、`layers` | 同名字段 | 可映射；M1 总图层格数限制为 180,000，前端的 2,000×2,000 画板尺寸上限不能等同于云端可保存上限。 |
| `BoardLayer.id` | `layerId` | 可映射，只要保留稳定值；UUID 格式符合后端限制。 |
| `BoardLayer.gridDimensions.{N,M}` | `{columns,rows}` | 需改名。 |
| `sourceImageSrc` | `sourceAssetId` | 不能直接映射。Data URL/本地 URL 必须先执行 `upload-intent → PUT → confirm`；图层若无已确认原图，则传 `null` 并设置 `regenerationCapability=unavailable`。 |
| `thumbnailDataUrl` | `thumbnailAssetId` | 同上；需先受控上传为 `display` 或 `thumbnail`，再传资产 ID，绝不传 Data URL。 |
| `sourceImportMode`、`templateImportConfidence`、再生成参数 | 同名/`generation`/`regenerationCapability` | 可映射，但必须由适配层计算 `available`、`template_locked` 或 `unavailable`，不能直接复用前端可选字段。 |
| `boardPixels` | `directPixels` | 需改名。仅填充格可直接成为像素单元；历史透明格必须转为 `erasePixels`。 |
| `boardErasePixels`、`legacyEraseMasks` | `erasePixels` | `boardErasePixels` 可映射；`legacyEraseMasks` 必须先与现有 `migrateLegacyBoardEraseMasks` 合并，后端 v1 不接受该旧字段。 |
| `skipColorReplacement: true` | `colorMode: final` | 必须转换，不能把前端内部字段名带入 API。无该标志的直接补色使用 `colorMode: inherited`。 |
| `colorReplacements` | 同名字段 | 可映射，但在提交前必须已展平；后端拒绝链式/循环映射。 |
| 本地草稿 `version:4`、`revision`、编辑 session | 不上传 | 云端并发只使用后端返回的顶层 `documentRevision` 和写入时的 `expectedRevision`。 |

## 首次真实联调的前端工作（本记录不是授权改动）

1. 新建独立 API client：固定后端基址，所有浏览器调用使用 `credentials: 'include'`，不直连 Payload Admin 或对象存储路径。
2. 新建纯转换层：`SavedPatternAsset → WorkDocument v1`、`BoardState → WorkDocument v1` 与反向恢复；禁止在组件中临时拼 JSON。
3. 将“保存到云端”保留为用户主动动作。按 `POST /works → upload-intent → PUT → confirm → PATCH /document` 执行；每个状态改变请求生成稳定的 `Idempotency-Key`。
4. 保存成功后持久化后端 `workId`、`documentRevision` 和资产 ID 映射；后续更新必须带最新 `expectedRevision`，收到 `WORK_REVISION_CONFLICT` 时提示刷新或另存副本，不能本地覆盖。
5. 实现 `GET /works` / `GET /works/:id` 的云端读取与反向转换。先用脱敏 2×2 pattern、4×3 board（包含覆盖、擦除、`inherited`/`final` 换色）做往返比对。
6. 按当前后端限制在 UI 提前提示：单图/单图层 90,000 格、总图层 180,000 格、20 层、8 MiB JSON、20,000 稀疏编辑；但仍以服务端拒绝为最终边界。
7. 在模式选择后处理原图：当前 `pattern` 不上传原图；`board` 仅当用户明确选择保留且上传确认成功时保存资产引用。不能自动把本地 Data URL 或已有 IndexedDB 内容上传。

## 当前阻塞与不做事项

- 真实浏览器 Cookie 会话、注册邮箱、真实邮件、Google OAuth、team-test、DNS 和云端存储均未创建或验证。
- 前端 `board` 页面当前约 300 ms 自动写入本地草稿；这不应直接迁移成后端自动保存。M1 只允许用户明确主动云端保存，避免限流、跨设备冲突和未确认原图上传。
- 后端不会修改 PixoMosaic 前端仓库；前端适配层的实现、测试和提交应在前端仓库内由其负责。

## 下一次验收标准

- 记录前端提交、后端分支和本地环境；使用不含真实客户信息的 2×2 `pattern` 与 4×3 `board` 样本。
- 两类样本经 API 保存、读取并恢复后，矩阵、颜色统计、图层顺序、擦除/补色和修订号保持一致。
- 验证一次乐观锁冲突、A/B 越权拒绝、未确认资产拒绝、删除后立即不可读；不以开发期 `/api/board-draft` 成功代替 M1 API 验收。
- 只有真实前端往返记录完成后，才评估 `pattern` 资产兼容扩展；该扩展须新建版本化 spec 和迁移方案。
