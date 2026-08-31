# M2 图纸册与灵感库 API（本地 v1）

> 状态：M2 后端已在本机实现并经集成测试验证；本文是前端联调的正式接口事实。公开社区层使用独立表和冻结版本，既有 `Work`、`WorkDocument`、`WorkAsset` 仍是 owner-only/private。

## 图纸册

- `GET /api/v1/library`：当前活动用户的全部 active Work、文件夹和标签。当前**没有**服务端筛选、排序参数或分页：始终按 `Work.updatedAt DESC, id DESC` 返回全部结果，且 `nextCursor: null`；Work 没有整理记录时返回默认 `makingStatus: draft`。
- `GET /api/v1/library/trash`：当前用户 `pending_deletion` Work 和 `recoverableUntil`。
- `PATCH /api/v1/library/works/:workId`：请求 `{ folderId: string|null, labelIds: string[], makingStatus: draft|to_make|making|completed }`。最多 5 个标签，每个标签最多 20 个 Unicode 字符；只写整理表，不触发库存。
- `POST /api/v1/library/works/:workId/restore`：请求 `{ expectedRevision }`，仅恢复本人 30 天窗口内的 `pending_deletion` Work。恢复不重新发布曾被下架的社区帖子。
- `POST/PATCH/DELETE /api/v1/library/folders[/:id]`、`POST/PATCH/DELETE /api/v1/library/labels[/:id]`：一级文件夹和标签的 owner-only 管理。

## 社区

- `GET /api/v1/community`、`GET /api/v1/community/:postId`：匿名可读的 `published` 安全投影。列表支持 `q`、`category`、`tag`、`sort`、`limit`（1–50，默认 24）及 opaque seek `cursor`；cursor 绑定当前排序和三个筛选项，混用或格式错误返回 `422 COMMUNITY_INPUT_INVALID`。只返回社区 public ID、标题、分类、标签、作者公开昵称、作者 `creatorId`、版本统计、社区媒体 public ID、相对受控媒体路径（`/api/v1/community/media/:mediaId`）和互动统计；不返回邮箱、内部数字 ID、WorkDocument、WorkAsset、storageKey、私有 URL 或私有媒体。`author.creatorId` 仅来自 `community_creator_profiles.public_id`（`creator_` 加 32 位十六进制公开标识），可安全用于 `/creators/:creatorId`；绝不由 `users.id`、`owner_id` 或其他内部数字 ID 派生或替代。
- 社区正式排序为：`recommended`（默认；`isFeatured=true` 的已公开帖子优先，组内按 `publishedAt DESC, id DESC`；**没有任何精选时等同最新**）、`latest`（`publishedAt DESC, id DESC`）、`likes`（前端显示“点赞最多”；`likeCount DESC, publishedAt DESC, id DESC`）、`favorites`（`favoriteCount DESC, publishedAt DESC, id DESC`）。`hot`、`popular` 仅兼容旧调用，均等价 `likes`；新前端和新文档不得使用“最热”。未知 `sort` 返回 `422 COMMUNITY_INPUT_INVALID`。
- `nextCursor` 只基于该请求稳定排序中的最后一条记录继续读取，包含排序键、`publishedAt`、内部并列键和筛选摘要；同一排序/筛选条件下不会因同一排序键的并列项重复或漏项。排序数据在翻页期间发生变化时，cursor 不提供跨请求快照隔离，前端应把刷新当作新的列表会话。
- `POST /api/v1/community/media/upload`：认证用户上传独立社区衍生媒体；通过 `X-Community-Media-Role: cover|gallery` 标记角色，返回 `mediaId`。媒体只能先处于当前用户的未绑定状态，再被自己的发布请求绑定。
- `POST /api/v1/community`：已验证且活动账号从自己的 active Work 发布。请求至少包含 `workId`、`title`、`category`、`tags`、`copyrightConfirmed: true`、`allowCopy`（默认 true）、`coverMediaId`；可带最多 9 个 `galleryMediaIds`。服务端检查媒体 owner/角色/未绑定状态后冻结 `PublishedPatternVersion`，私有 Work 后续编辑不改变该版本。
- `PATCH /api/v1/community/:postId`：作者可改标题、社区封面、分类、标签和 `allowCopy`，不覆盖冻结图纸内容。`coverMediaId` 必须是当前用户上传、尚未绑定其他帖子的独立社区封面；过程附图本期不可替换。
- `POST /api/v1/community/:postId/withdraw`：作者主动下架。源 Work 进入 `pending_deletion` 或被物理删除时，数据库触发器也会自动下架关联 published 帖子。
- `POST /api/v1/community/:postId/copy`：复制开启时，在同一事务创建复制者自己的 active private Work 和 `CopyProvenance`。board 深拷贝会清除所有 `sourceAssetId`/`thumbnailAssetId`，有原图引用的图层设置 `regenerationCapability: unavailable`。
- `PUT/DELETE /api/v1/community/:postId/like`、`PUT/DELETE /api/v1/community/:postId/favorite`：同一用户同一帖子唯一，重复请求幂等。
- `POST /api/v1/community/:postId/report`：理由为 `copyright`、`adult_violence`、`harassment`、`spam` 或 `privacy`；举报人只在受控表和审计中保存。
- `GET /api/v1/community/media/:mediaId`：仅允许 published 帖子的独立社区媒体；当前本地发布接口只冻结 media 元数据，未配置对象存储时返回 `COMMUNITY_MEDIA_NOT_FOUND`，不会退回私有 WorkAsset。

## 社区资料（已实现）

- `GET /api/v1/community/profile`：认证用户读取自己的社区资料和全部社交链接，包含每条 `visibility: public|hidden`。
- `PATCH /api/v1/community/profile`：认证用户维护自己的 `displayName`、`bio`。社交链接通过 `PUT /api/v1/community/profile/social-links/:platform` 以 `{ url, visibility }` 单平台写入，`DELETE` 删除；第一版允许 `instagram|tiktok|youtube|pinterest|facebook|x|reddit|linkedin`，每平台最多一条，HTTPS 且必须匹配平台允许域名，默认/可选 `hidden`。
- `GET /api/v1/community/creators/:creatorId`：匿名只读作者资料安全投影，只返回公开展示资料和 `visibility=public` 的社交链接；不返回隐藏链接、邮箱、内部用户 ID、私密 Work 或运营备注。
- 社交链接不能是短链、跳转链接、嵌入代码或含凭据的 URL；公开链接在前端以 `rel="ugc nofollow noopener noreferrer"` 打开，不写入 JSON-LD `sameAs`、sitemap 或分享图。

## M2 后续用户能力（正式契约冻结）

本节冻结用户侧后续能力的字段、权限和状态语义。它不复用 M2.2 Admin API，也不把浏览器 `localStorage`、IndexedDB 或本地草稿当作事实来源。后端已实现本节三个读取路由与不可用收藏的幂等取消；尚待前端接入和本机 QA 验收，因此不得把它们描述为已上线能力。

本节新增响应统一使用 `CommunitySuccess<T> = T & { requestId: string }`；`PublishedCommunityPost` 是本文“社区”章节已冻结的公开帖子安全投影（仅 `published` 时可供匿名读取），不等同于 Admin 帖子类型。三个读取路由已在后端实现并由 `m2-community-auth.int.spec.ts` 覆盖契约边界；本机集成测试仍需可用 PostgreSQL 才能执行。

```ts
export type CommunitySuccess<T extends object> = T & { requestId: string }

export type PublishedCommunityPost = {
  postId: string
  title: string
  category: string
  tags: string[]
  status: 'published'
  allowCopy: boolean
  author: { creatorId: string; name: string; displayName: string }
  publishedAt: string
  coverUrl: string | null
  gallery: Array<{ mediaId: string; url: string; alt: string | null }>
  version: {
    versionId: string
    kind: 'pattern' | 'board'
    gridColumns: number
    gridRows: number
    colorCount: number
    totalBeadCount: number
    difficulty: 'simple' | 'medium' | 'challenging'
    beadSizeMm: number | null
  } | null
  stats: { likeCount: number; favoriteCount: number }
  isLiked?: boolean
  isFavorited?: boolean
}
```

### 1. 本人已发布内容

`GET /api/v1/community/me/posts` 要求已登录、已验证且 `accountStatus=active` 的普通用户会话；服务端从会话取得 owner，客户端不得传入 `ownerId` 或其他用户筛选。返回仅限该用户仍保留的社区帖子安全状态卡，不返回 Work、WorkDocument、WorkAsset、原图、邮箱、举报、治理原因、运营备注、内部数字 ID、对象存储键或 Token。

```ts
export type MyCommunityPost = {
  postId: string
  title: string
  category: string
  tags: string[]
  status: 'published' | 'withdrawn' | 'takedown' | 'deleted'
  allowCopy: boolean
  publishedAt: string
  updatedAt: string
  coverMedia: { mediaId: string; url: string; altText: string | null } | null
  stats: { likeCount: number; favoriteCount: number }
}

export type MyCommunityPostsResponse = CommunitySuccess<{
  posts: MyCommunityPost[]
  nextCursor: string | null
}>
```

列表排序固定为 `updatedAt DESC, 数据库内部 id DESC`；支持 `status`（可重复、逗号分隔的上述状态，缺省为全部）、`cursor` 和 `limit`（默认 24，限制到 `1..50`）。`nextCursor` 是绑定当前状态筛选和排序的不透明 seek cursor；无下一页为 `null`，客户端不得解析、拼接或跨筛选复用。无效 cursor/limit/status 返回 `422 COMMUNITY_INPUT_INVALID`。

`published` 帖子可带相对受控的 `coverMedia`；`withdrawn`、`takedown`、`deleted` 帖子的 `coverMedia` 必须为 `null`，不暴露下架/删除原因。帖子记录已被物理清理时可不再出现在列表；该读取不承诺历史保留或恢复能力。

### 2. 公开作者资料与帖子

`GET /api/v1/community/creators/:creatorId` 保持匿名读取，并将公开作者资料扩展为以下安全投影；`avatarUrl` 没有值时为 `null`，统计只计算该作者当前 `published` 帖子，不包含撤回、下架或删除内容：

```ts
export type PublicCreatorProfile = {
  creatorId: string
  avatarUrl: string | null
  displayName: string | null
  bio: string | null
  socialLinks: Array<{
    platform: 'instagram' | 'tiktok' | 'youtube' | 'pinterest' | 'facebook' | 'x' | 'reddit' | 'linkedin'
    url: string
  }>
  stats: { likeCount: number; favoriteCount: number }
}

export type PublicCreatorResponse = CommunitySuccess<{
  creator: PublicCreatorProfile
}>
```

`socialLinks` 仅包含 `visibility=public` 且通过 HTTPS 平台域名校验的链接；隐藏链接、邮箱、内部用户 ID、私有 Work/WorkDocument/WorkAsset、运营备注、举报和治理历史永不进入匿名响应。`PublishedCommunityPost.author.creatorId` 与作者资料路由使用同一 `community_creator_profiles.public_id`，不是内部用户/owner 数字 ID；不存在或格式不合法的 `creatorId` 返回 `404 COMMUNITY_CREATOR_NOT_FOUND`。

新增 `GET /api/v1/community/creators/:creatorId/posts`，匿名仅返回该作者当前 `published` 帖子，帖子字段复用 `PublishedCommunityPost` 安全投影（不带 Admin 状态字段），不返回私有作品或治理信息：

```ts
export type PublicCreatorPostsResponse = CommunitySuccess<{
  posts: PublishedCommunityPost[]
  nextCursor: string | null
}>
```

排序固定为 `publishedAt DESC, 数据库内部 id DESC`；支持 `cursor`、`limit`（默认 24，限制到 `1..50`），cursor 绑定 `creatorId` 和排序。无效 creator ID/cursor/limit 分别返回 `404 COMMUNITY_CREATOR_NOT_FOUND` 或 `422 COMMUNITY_INPUT_INVALID`。作者没有公开帖子时返回空数组和 `nextCursor: null`。

### 3. 私有收藏集合

新增 `GET /api/v1/community/favorites`，要求已登录、已验证且活动账号；只读取当前会话用户的收藏关系，禁止传入 owner 或读取其他用户集合。可用帖子项复用 `PublishedCommunityPost` 安全投影；排序固定为收藏关系 `createdAt DESC, 数据库内部 id DESC`，支持 `cursor`、`limit`（默认 24，限制到 `1..50`），cursor 绑定当前用户和排序。

```ts
export type FavoriteUnavailable = {
  postId: string
  availability: 'unavailable'
  displayLabel: '内容不可用'
  favoritedAt: string
}

export type FavoriteItem =
  | (PublishedCommunityPost & { availability: 'available'; favoritedAt: string })
  | FavoriteUnavailable

export type CommunityFavoritesResponse = CommunitySuccess<{
  favorites: FavoriteItem[]
  nextCursor: string | null
}>
```

当帖子撤回、下架或删除但收藏关系仍保留时，必须返回 `FavoriteUnavailable` 占位；占位不含标题、媒体、作者、状态、治理原因或任何内部字段，只显示“内容不可用”。`DELETE /api/v1/community/:postId/favorite` 对 `available` 和 `unavailable` 两种收藏都允许，要求当前用户会话、可信 Origin、`Idempotency-Key`，重复取消幂等；不存在或已取消的收藏按成功的幂等删除处理。若帖子记录物理删除导致关系级联清理，则该收藏不会再出现在集合中，也不得阻断其他请求。

### 4. 图纸册库存与完成制作

图纸册按需复用既有 owner-only 接口，不新增批量或 Admin 入口：

- `GET /api/v1/works/:id/inventory-status`：只读当前用户 `active` Work；服务端从保存快照计算 `colorHex` 用量。`availableQuantity: null` 表示未录入库存，不等于零；`health`、`producible`、`shortageQuantity` 和 `rules` 均以服务端账本/规则为准。未登录、他人作品或缺少规格分别返回统一认证/访问错误或 `WORK_BEAD_SIZE_REQUIRED`。
- `POST /api/v1/works/:id/complete`：只接受 `{ note: string | null }`，必须带 `Idempotency-Key` 和可信 Origin。服务端再次读取当前用户 active 快照，在单一事务内创建 `production_decrement` 操作并按底层 HEX 扣减；同一幂等键重试不重复扣减，不同幂等键代表新的制作操作。成功结果可通过 `DELETE /api/v1/inventory/operations/:id` 软删除原操作并生成唯一反向回滚。
- `PATCH /api/v1/library/works/:workId` 的 `makingStatus=completed` 只更新图纸册整理元数据，不扣库存；库存 `complete` 也不自动更新 `makingStatus`。两者必须保持独立，前端不得用连续两次请求伪造原子性。若未来需要原子联动，必须另行冻结新接口和事务语义。

以上接口沿用统一 `requestId`/错误对象、owner 隔离、可信来源、限流、审计和幂等规则；库存余额、账本明细和制作记录不得出现在公开社区或作者页面响应中。

后台的 M2.2 接口对社区域采用完整读取：`GET /api/v1/admin/community/users/:id` 返回该用户填写的全部社交链接（原始链接与每条 `visibility`，`hidden` 必须显示为“隐藏”）及完整社区档案入口；`GET /api/v1/admin/community/users/:id/posts` 默认可分页读取该用户所有状态的社区帖子；`GET /api/v1/admin/community/posts/:id` 可读取完整冻结发布内容、仍保留的社区媒体和治理历史。该边界不扩大到未发布私密作品/原图、邮箱、密码、会话、Token、对象存储键、订单、支付或地址。

所有认证写接口沿用 trusted Origin、活动会话、`Idempotency-Key`、事务、审计、限流和 request ID。社区浏览、发布、互动、复制、图纸册整理、删除和恢复均不写个人豆仓；库存扣减仍只经既有 `POST /api/v1/works/:id/complete`。
