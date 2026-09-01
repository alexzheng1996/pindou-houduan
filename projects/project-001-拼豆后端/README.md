# project-001-拼豆后端

## 项目目标

为 PixoMosaic 提供独立、可维护的拼豆后端设计与实现能力，并以明确的接口契约支持前端联调。

## 范围

- 后端架构、接口、数据处理、异步任务、持久化和安全边界的设计与实现。
- 面向 PixoMosaic 的接口契约、后端测试、联调记录和交接材料。
- 与拼豆图纸生成、图纸数据、导出、任务状态相关的后端能力，具体范围以后的项目需求和接口契约为准。

## 不做事项

- 不在本项目直接开发或修改 PixoMosaic 前端页面、组件、样式和前端构建配置。
- 不复制或迁移 `/Users/alexwork/Documents/PixoMosaic` 的源代码、未提交改动、构建目录或日志到本项目。
- 在接口字段、鉴权机制、部署方式和数据持久化需求未确认前，不擅自实现具体 API。

## 当前状态

已于 2026-08-18 立项。**M0 技术基础、M1 本地邮箱认证、私密作品模型、`pattern` / `board` 的 draft 创建、读取和激活更新、文件闭环、审计反滥用，以及 Google 本机 OIDC Mock 均已完成；M1.1 个人豆仓的后端账本、作品规格兼容、CSV 导入和缺货导出已完成本机验证。后端 M1/M1.1 已提交为 `9b09978` / `849d681`；PixoMosaic 前端云端作品/豆仓接入已在其独立仓库提交为 `f809556`。当前结论是“本机浏览器 HTTP 技术 Go”，不等同于 team-test/生产完整前后端联调；完整 team-test 仍先要补齐私有 R2 存储适配、受控迁移发布和清理调度，再由业务方按费用 Go 决定是否创建云资源。**

- 已固定 Node `24.19.0`、pnpm `10.33.2`、Payload 与 PostgreSQL 适配器 `3.88.0`，并完成本地 PostgreSQL、显式迁移、`/health`、自动化测试与 Docker 生产模式健康检查。
- M1 的 `/api/v1` 交换规则和 `WorkDocument` v1 数据契约已冻结为工程基线；已完成 PixoMosaic 的主动云端保存/打开、服务端库存展示、`/inventory` 账本/CSV 与制作扣减 UI 代码接入，并以真实浏览器验证 Cookie 会话、作品保存、库存导入/回滚、制作扣减/回滚和 A/B 隔离；浏览器未把本地草稿、Data URL 或用户标识送入业务 API。该结果仅覆盖本机 HTTP，不代表 team-test/生产完整前后端联调。
- PixoMosaic 的个人豆仓设计已纳入 M1.1：库存由后端按 `owner + beadSizeMm + colorHex` 管理，以余额和不可变账本支持入库、盘点、导入、制作扣减和删除回滚；CSV 模板、预检/10 分钟冻结确认、缺货 CSV 已本机通过。当前前端 291 色、5 套显示系统、2.6/5mm 规格和颜色统计可复用；美国市场色号品牌/色表来源未确认，且现有“漫漫 S4”有一号对应两 HEX 的歧义，因此导入必须预检拦截，不能猜测实现。
- M1 本地认证已完成邮箱密码注册、邀请/白名单判断、15 分钟一次性哈希 OTP 验证、登录、忘记/重设密码、连续 5 次错误密码锁定 15 分钟、停用账号拒绝登录、Cookie/CORS/CSRF 与显式迁移；密码重设令牌单次消费并撤销旧会话。本地邮件仅进入受控 outbox，不发送真实邮件。Google 本机 OIDC Mock 已验证授权码、PKCE、state、nonce、ID Token 签名、issuer、audience、`email_verified` 与显式账号绑定；它不等同于已配置真实 Google OAuth。私密的 Work / WorkDocument / WorkAsset 与持久化幂等模型已迁移并验证；`POST /api/v1/works` 可原子创建严格校验的 `pattern` 或无资产 `board` draft 与 revision 0 快照；`GET /api/v1/works` 和 `GET /api/v1/works/:id` 只读取本人 active 作品；`PATCH /api/v1/works/:id/document` 以数据库乐观锁更新快照、首次激活作品，并强制每用户最多 50 个 active 作品。`board` 已按 v1 校验图层/格点/坐标/叠放/材料清单，且其 `sourceAssetId` / `thumbnailAssetId` 必须为本人、当前作品、`ready` 且角色匹配的私有资产。M1 本地受控文件闭环也已完成：本人可申请 intent、PUT PNG/JPEG/WebP、confirm 并私有下载；真实字节、大小、哈希、作品/用户配额及 A/B 隔离均由服务端验证。作品删除闭环已加入：草稿取消立即隐藏，active 作品进入 30 天回收期，`pnpm cleanup:works` 按对象→资产→快照→作品顺序执行本机物理清理。审计与反滥用已完成本地最小闭环：认证继续使用 Better Auth 数据库限流/账号锁定；业务按活动用户限制作品写入、上传 intent/PUT/confirm 与私有下载，最小审计不保存邮件、文件内容、存储键、Token 或 IP 原文；`pnpm cleanup:security` 清理 90 天审计、2 天限流桶和已过期的幂等缓存。`pattern` 资产引用字段、真实邮件、真实 Google OAuth 和 team-test/生产联调仍未完成。
- 主域名已确认是 `pixomosaic.com`；未创建云账号、对象存储桶、邮件账号、OAuth、`api-test.pixomosaic.com` DNS 记录或线上部署，也不需要 Cloudflare 凭据；本次已获业务方授权修改 PixoMosaic 前端独立仓库，其 Git 改动仍由前端仓库单独管理。
- 完整验收证据和 M1 进入条件见 `docs/验收/阶段验收记录.md` 与 `handoff/M0-技术基础完成与M1-Go清单.md`。
- M2.1-A 官方内容草稿后台已完成本机闭环；M2.2 社区治理后端也已完成本机闭环：Staff/Admin 可在受控 API 中查看社区域的全状态帖子、冻结快照、保留媒体、举报、用户社交资料、内部备注和特别关注，并执行精选、下架/恢复、举报处理与 Admin 删除。普通公开帖子自动可分享，仍公开且精选的帖子自动派生为可收录；实际 sitemap、结构化数据、公开分享按钮、视频、内容发布/MCP 和前端管理页面仍未实现或联调。具体边界见 `docs/接口/M2.1-内容中心与SEO-GEO-API.md`、`docs/接口/M2.2-社区治理后台-API.md` 及 `docs/验收/阶段验收记录.md`。
- M2 后续用户能力与 M2.1-B 公开内容契约已纳入当前后端分支 `codex/m2-library-community@3033f1a`：先以快进方式纳入统一用户能力提交 `e84f1f8`，再以无快进合并纳入公开内容契约提交 `1d68dc5`，形成合并提交 `3033f1a`。合并后 `tests/int/m2-community-auth.int.spec.ts` 为 1 个文件 / 5 项通过；当前工作树仍保留合并前已存在的库存规则 3 个未提交文件与 `.playwright-*` 临时目录，未纳入本次合并。历史库存阈值分支 `codex/m1-inventory-threshold@ff07e6b` 与主线祖先 `35a128f` 的稳定 patch-id 完全一致，功能已在当前主线，无需再合并；完整用户能力本机 QA、team-test 与生产仍未验收。

## 目录说明

- `docs/`：接口契约、设计、决策、联调和复盘。
- `src/`：后端源代码。
- `tests/`：单元、集成、接口与联调测试。
- `scripts/`：本项目专用自动化和验证脚本。
- `data/`：原始和处理后的非敏感数据。
- `output/`：报告和可交付结果。
- `logs/`：运行、验证、排障记录。
- `handoff/`：交接材料与验收说明。

## 当前关键文档

- `docs/specs/00-后端总调度与阶段门禁-spec.md`：M0–M4 的阶段边界、总调度职责和 Go / No-Go 门禁。
- `docs/specs/02a-M1-本地受控文件存储-spec.md`：M1 图片上传、确认、私有读取和本地对象存储替身的最小安全边界。
- `docs/specs/02b-M1-审计与反滥用-spec.md`：M1 已认证业务限流、最小审计、隐私和保留期边界。
- `docs/specs/02c-M1-Google本地OIDC-Mock-spec.md`：Google 本机 OIDC Mock 的安全门禁、已验证范围与真实接入边界。
- `docs/specs/02d-M1-真实邮件适配器准备-spec.md`：官方 Resend 适配器的本地安全替身、team-test 启用条件与不做项。
- `docs/specs/02e-M1.1-个人豆仓与制作扣减-spec.md`：个人豆仓账本、事务、图纸扣减、导入、色号治理、联调顺序和验收。
- `docs/specs/02f-M1-team-test-私有R2与发布调度-spec.md`：team-test 前置的私有 R2 存储、受控迁移发布、清理调度、成本与验收门禁；待业务方审阅。
- `docs/specs/03-M2-社区MVP-spec.md`：用户发布即公开的社区发布、互动、复制、举报与撤回范围；运营治理另见 M2.2。
- `docs/specs/03a-M2.1-官方内容中心与SEO-GEO-spec.md`：官方 Guides/Blog、人工审核、SEO/GEO、分享、品牌视频和仅草稿的 Codex/MCP 边界；M2.1-A 已按其草稿后台边界实现，其余能力待后续阶段。
- `docs/specs/03b-M2.2-社区治理后台-spec.md`：运营查看用户内容、精选、下架、举报、用户备注、特别关注和审计；后端本机闭环已完成。
- `docs/M2.1-内容中心与社区治理-SEO-GEO-讨论基线.md`：上述两份 Spec 的已确认业务决策和讨论依据。
- `docs/specs/01-M0-基础架构与M1接口冻结-spec.md`：M0-A / M0-B 的实施范围与验收。
- `docs/接口/M1-作品数据契约.md`：单图图纸和画板云端作品的 v1 字段、文件与兼容边界。
- `docs/验收/M1-PixoMosaic-只读契约核对-2026-08-22.md`：当前前端数据与 v1 的映射、差异和首次联调清单；不包含前端改动。
- `docs/复用评估/M1.1-个人豆仓-复用与依赖评估.md`：前端资产、CSV/Excel 依赖和不引入项的核查结论。
- `docs/实施准备/M0-本机环境与云端账号清单.md`：M0 本地基础的复现方式，以及 M1 前要确认的账号权限。
- `docs/决策/M0-团队验证供应商与权限决策.md`：团队验证环境的推荐组合、账号最小权限、预算确认点和不开户边界。
- `docs/实施准备/M1-team-test-部署前检查与费用Go.md`：本地完成后的费用、停止/删除方案和 team-test 创建授权检查。
- `docs/复用评估/M1-认证方案核查.md`：Google 登录的成熟方案评估与 PoC 门禁。
- `handoff/M0-技术基础完成与M1-Go清单.md`：给总调度和业务方的 M0 收口、M1 Go/No-Go 清单。
- `handoff/M1.1-本机验证完成与team-test准备-2026-08-24.md`：本机验证基线、team-test No-Go 门禁、后续固定顺序和前端“新建画板”补充任务。

## 运行或验证方式

在项目服务目录内执行以下命令，可复核 M0 本地基础：

1. `fnm exec --using ../../.node-version pnpm install --frozen-lockfile`
2. `docker compose up -d postgres && fnm exec --using ../../.node-version pnpm migrate:status`
3. `fnm exec --using ../../.node-version pnpm lint && fnm exec --using ../../.node-version pnpm test && fnm exec --using ../../.node-version pnpm build`；仅本机验证需要清理过期资产、作品、安全记录或库存导入预览时执行 `fnm exec --using ../../.node-version pnpm cleanup:assets` / `fnm exec --using ../../.node-version pnpm cleanup:works` / `fnm exec --using ../../.node-version pnpm cleanup:security` / `fnm exec --using ../../.node-version pnpm cleanup:inventory-imports`。

开发服务仅监听本机：`fnm exec --using ../../.node-version pnpm dev`，再访问 `http://127.0.0.1:3002/health`。本机 PixoMosaic 单图/画板前端分别使用 `3050`/`3100`；不得用当前机器的 Node 25 代替项目基线；不得在没有 M1 Go 的情况下创建或连接任何团队/生产云资源。

## 验收标准

- 后端边界、接口契约、数据责任和错误处理可被 PixoMosaic 前端据此联调；M1.1 库存 API 已通过 48 项本机集成测试、lint 和生产构建。
- M0 的后端基础及 M1 本地邮箱认证、Google OIDC Mock、作品/文件/删除、审计反滥用和真实邮件适配器准备具备自动化测试和可追溯验证记录；M1/M1.1 已完成本机浏览器 HTTP 技术验证，但真实邮件投递、真实 Google OAuth、team-test 和生产环境完整联调尚未完成。
- 所有项目相关文件均在本项目目录内，不依赖复制前端仓库文件。

## 与 PixoMosaic 的协作边界

- 前端仓库：`/Users/alexwork/Documents/PixoMosaic`。
- 后端仓库：当前 Workspace。
- 协作媒介：本目录 `docs/前后端接口契约.md` 中的版本化契约和联调记录。
- 未经用户明确授权，后端任务不得修改 PixoMosaic 仓库。

## 关键结论与复盘

- 当前最重要的前置是完成 M1 环境的业务 Go：业务方持有并确认测试账号、域名/DNS、发件域和预算；技术基础不等于已获准上线。
- 任何跨仓库协作都应以接口和验收记录连接，避免以共享文件路径或复制代码耦合。
