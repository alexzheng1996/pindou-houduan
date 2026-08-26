# M2 图纸册与灵感库 API（本地 v1）

> 本文只描述本次本地 M2 实现的业务边界。公开社区层使用独立表和冻结版本，既有 `Work`、`WorkDocument`、`WorkAsset` 仍是 owner-only/private。

## 图纸册

- `GET /api/v1/library`：当前活动用户的 active Work、文件夹和标签。Work 没有整理记录时返回默认 `makingStatus: draft`。
- `GET /api/v1/library/trash`：当前用户 `pending_deletion` Work 和 `recoverableUntil`。
- `PATCH /api/v1/library/works/:workId`：请求 `{ folderId: string|null, labelIds: string[], makingStatus: draft|to_make|making|completed }`。最多 5 个标签，每个标签最多 20 个 Unicode 字符；只写整理表，不触发库存。
- `POST /api/v1/library/works/:workId/restore`：请求 `{ expectedRevision }`，仅恢复本人 30 天窗口内的 `pending_deletion` Work。恢复不重新发布曾被下架的社区帖子。
- `POST/PATCH/DELETE /api/v1/library/folders[/:id]`、`POST/PATCH/DELETE /api/v1/library/labels[/:id]`：一级文件夹和标签的 owner-only 管理。

## 社区

- `GET /api/v1/community`、`GET /api/v1/community/:postId`：匿名可读的 published 安全投影。列表支持 `limit`（1-50，默认 24）和 opaque `cursor` 分页。只返回社区 public ID、标题、分类、标签、作者公开昵称、版本统计、社区媒体 public ID 和互动统计；不返回邮箱、内部数字 ID、WorkDocument、WorkAsset、storageKey 或私有 URL。
- `POST /api/v1/community/media/upload`：认证用户上传独立社区衍生媒体；通过 `X-Community-Media-Role: cover|gallery` 标记角色，返回 `mediaId`。媒体只能先处于当前用户的未绑定状态，再被自己的发布请求绑定。
- `POST /api/v1/community`：已验证且活动账号从自己的 active Work 发布。请求至少包含 `workId`、`title`、`category`、`tags`、`copyrightConfirmed: true`、`allowCopy`（默认 true）、`coverMediaId`；可带最多 9 个 `galleryMediaIds`。服务端检查媒体 owner/角色/未绑定状态后冻结 `PublishedPatternVersion`，私有 Work 后续编辑不改变该版本。
- `PATCH /api/v1/community/:postId`：作者可改标题、社区封面、分类、标签和 `allowCopy`，不覆盖冻结图纸内容。`coverMediaId` 必须是当前用户上传、尚未绑定其他帖子的独立社区封面；过程附图本期不可替换。
- `POST /api/v1/community/:postId/withdraw`：作者主动下架。源 Work 进入 `pending_deletion` 或被物理删除时，数据库触发器也会自动下架关联 published 帖子。
- `POST /api/v1/community/:postId/copy`：复制开启时，在同一事务创建复制者自己的 active private Work 和 `CopyProvenance`。board 深拷贝会清除所有 `sourceAssetId`/`thumbnailAssetId`，有原图引用的图层设置 `regenerationCapability: unavailable`。
- `PUT/DELETE /api/v1/community/:postId/like`、`PUT/DELETE /api/v1/community/:postId/favorite`：同一用户同一帖子唯一，重复请求幂等。
- `POST /api/v1/community/:postId/report`：理由为 `copyright`、`adult_violence`、`harassment`、`spam` 或 `privacy`；举报人只在受控表和审计中保存。
- `GET /api/v1/community/media/:mediaId`：仅允许 published 帖子的独立社区媒体；当前本地发布接口只冻结 media 元数据，未配置对象存储时返回 `COMMUNITY_MEDIA_NOT_FOUND`，不会退回私有 WorkAsset。

## 社区资料（待 M2 Spec 批准后实现）

- `GET /api/v1/me/community-profile`：认证用户读取自己的社区资料和全部社交链接，包含每条 `visibility: public|hidden`。
- `PATCH /api/v1/me/community-profile`：认证用户维护自己的公开展示资料和社交链接。每条链接使用 `{ platform, url, visibility }`；第一版允许 `instagram|tiktok|youtube|pinterest|facebook|x|reddit|linkedin`，每平台最多一条，HTTPS 且必须匹配平台允许域名；默认 `hidden`。
- `GET /api/v1/community/creators/:creatorId`：匿名只读作者资料安全投影，只返回公开展示资料和 `visibility=public` 的社交链接；不返回隐藏链接、邮箱、内部用户 ID、私密 Work 或运营备注。
- 社交链接不能是短链、跳转链接、嵌入代码或含凭据的 URL；公开链接在前端以 `rel="ugc nofollow noopener noreferrer"` 打开，不写入 JSON-LD `sameAs`、sitemap 或分享图。

后台的 M2.2 接口对社区域采用完整读取：`GET /api/v1/admin/community/users/:id` 返回该用户填写的全部社交链接（原始链接与每条 `visibility`，`hidden` 必须显示为“隐藏”）及完整社区档案入口；`GET /api/v1/admin/community/users/:id/posts` 默认可分页读取该用户所有状态的社区帖子；`GET /api/v1/admin/community/posts/:id` 可读取完整冻结发布内容、仍保留的社区媒体和治理历史。该边界不扩大到未发布私密作品/原图、邮箱、密码、会话、Token、对象存储键、订单、支付或地址。

所有认证写接口沿用 trusted Origin、活动会话、`Idempotency-Key`、事务、审计、限流和 request ID。社区浏览、发布、互动、复制、图纸册整理、删除和恢复均不写个人豆仓；库存扣减仍只经既有 `POST /api/v1/works/:id/complete`。
