# 拼豆后端 Workspace 入口规则

本 Workspace 用于 PixoMosaic 的拼豆后端设计与实现。开始任何会读取、创建或修改文件的任务前，先阅读 [全局工作台](docs/workspace/全局工作台.md)。

- 全局行为、目录和命名规则以 `docs/workspace/全局工作台.md` 为准。
- 启动正式项目时，必须执行 `docs/workspace/新项目SOP.md`。
- 调试、复盘或形成稳定做法后，查阅并更新 `docs/workspace/全局复利与踩坑日志.md`。
- 所有正式项目内容必须存放在 `projects/project-三位编号-项目名称/` 内；不得把项目文件长期散落在本 Workspace 的其他位置或电脑其他位置。
- PixoMosaic 前端位于 `/Users/alexwork/Documents/PixoMosaic`，是独立仓库。除非用户明确授权，不修改其文件；通过本项目的接口契约协作。

## 跨项目调度协作

- 本项目由 `/Users/alexwork/Documents/ChatGPT/Coordination` 统一协调；接收调度任务后，先阅读对应任务卡、最近阶段交接包、本项目适用的 Spec 和正式接口契约，再开始实现。
- 本仓库只负责 API、鉴权、数据库、迁移、服务端测试和管理能力；不得直接修改前端仓库。接口契约以本仓库标记为正式版本的文档为唯一技术事实来源，变更时同步告知调度中心及受影响的前端任务。
- 发现前后端口径不一致、认证/环境阻塞或任务范围不清时，先回报调度中心并记录证据；不要通过猜测字段、临时兼容分支或越界修改前端来“先跑通”。
- 任务开始前确认当前分支、工作区改动和允许写入范围；只在本仓库及任务卡允许的范围内写入，不把临时调试产物、凭据或跨项目文件带入提交。
- 完成后按 Coordination 的“任务卡与线程回传模板”回传：产出位置、分支/提交、验证证据、未验证项、接口/跨项目影响、未提交文件、风险和下一步。单仓库测试通过不等同于跨项目联调验收。

### 临时工作树与封测边界

- 临时工作树仅服务于已明确登记的任务；创建时记录来源主线提交、唯一任务和回收条件。
- 任务完成后先形成提交并合入主树、完成必要验证，再按回收条件清理临时工作树；不得在验证前删除唯一副本。
- 遇到环境或权限失败时，不得反复创建工作树；封测默认遵守“1 主树 + 1 写入临时树 + 1 固定验收树”。
- 已登记的后端开发/QA 任务可读取项目共享测试账号配置，并仅在进程内使用；账号与数据必须限于本地、可识别且可回收的测试范围。禁止读取、回传或写入凭据，禁止触碰未知历史数据、真实业务数据、数据库结构或生产/团队环境。
- 共享测试账号配置路径为 `/Users/alexwork/Documents/ChatGPT/Coordination/.env.m2-qa.local`；仅按登记任务在进程内读取，不得复制、回传或提交文件内容。

### 已有项目与新项目 SOP

- `docs/workspace/新项目SOP.md` 适用于启动新的正式项目；已有项目的日常开发、修复、契约维护和联调，按本项目现有文档、任务卡和调度中心交接执行，不因每次任务重复创建项目归档。

## 项目交接信息（2026-09-02）

> 本节是交给下一位开发者或 Codex 任务的项目状态摘要。详细接口字段、验收证据和阶段门禁仍以 `projects/project-001-拼豆后端/docs/` 与 `projects/project-001-拼豆后端/handoff/` 下的版本化文档为准；本节不包含任何账号、密钥或 Token。

### 1. 技术栈与启动方式

- 运行时：Node `24.19.0`（项目根目录 `.node-version`）、pnpm `10.33.2`；不要使用 Node 25。
- 应用：Next.js `16.3.0` + Payload CMS `3.88.0`，TypeScript `5.7.3`，Better Auth `1.7.1`，React `19.2.6`。
- 数据库：PostgreSQL 16；本机由 Docker Compose 提供，仅绑定 `127.0.0.1:55440`。
- 对象存储：本机使用受控 local object store；team-test/生产必须显式使用私有 R2/S3 兼容存储，禁止回退本机磁盘。
- 邮件：本机写入受控 local outbox；真实 Resend 适配器尚未启用。
- 服务目录：`projects/project-001-拼豆后端/src/service/`。
- 首次安装和本机启动：

  ```bash
  cd projects/project-001-拼豆后端/src/service
  fnm exec --using ../../.node-version pnpm install --frozen-lockfile
  docker compose up -d postgres
  fnm exec --using ../../.node-version pnpm migrate:status
  fnm exec --using ../../.node-version pnpm dev
  curl --fail http://127.0.0.1:3002/health
  ```

- 常用验证：`pnpm lint`、`pnpm test`、`pnpm build`、`pnpm exec tsc --noEmit`；数据库只通过 `pnpm migrate` / `pnpm migrate:status` 管理。Docker 生产模式可用 `docker build -t pixomosaic-backend:m0-local .` 验证。
- 本机配置从 `src/service/.env.example` 复制为未纳入 Git 的 `.env`；不得把真实配置写入仓库。默认 `APP_ENV=local`、`OBJECT_STORAGE_MODE=local`、`GOOGLE_OAUTH_MODE=disabled`、`MAIL_TRANSPORT=local-outbox`。

### 2. 已完成功能清单

- M0：独立 Payload + PostgreSQL 服务骨架、显式迁移、健康检查、Docker 基线、API v1 总则、数据边界和安全/供应商决策文档。
- M1 账号与认证：邮箱密码注册/登录、邀请/白名单、邮箱验证 OTP、忘记/重设密码、密码错误锁定、停用账号、Cookie/CORS/CSRF、会话撤销；Google 本机 OIDC Mock 已覆盖 PKCE、state、nonce、签名和账号绑定校验。
- M1 作品：私密 `pattern` / `board` 作品 draft 创建、读取、更新、首次激活、revision 乐观锁、每用户最多 50 个 active 作品；严格校验图层、格点、坐标、叠放、材料清单和本人资产引用。
- M1 文件：`upload-intent → PUT → confirm → 私有 GET` 闭环，校验 MIME/真实字节/解码/SHA-256/归属/状态/配额；支持 PNG、JPEG、WebP，响应不暴露存储键或磁盘路径。
- M1 生命周期与安全：作品删除回收站与 30 天清理、资产/安全记录/幂等缓存清理、已认证业务限流、最小审计和 A/B 用户隔离。
- M1.1 个人豆仓：按 `owner + beadSizeMm + colorHex` 的余额与不可变账本、入库/盘点/调整、CSV 预检与 10 分钟冻结确认、制作扣减/回滚、缺货导出、库存状态和规格兼容校验；本机浏览器与 48 项集成测试已验证。
- M2 图纸册与社区：文件夹/标签/回收站、社区发帖、公开作者页与安全投影、收藏集合、点赞/复制/举报/撤回、媒体上传及用户社交资料；用户能力合并基线为 `3033f1a`。
- M2.1-A 内容后台：Staff/Admin 可创建、读取、更新仅 `draft` 的 Guides/Blog 文章，含 Lexical 正文、来源清单、SEO 建议、幂等、版本冲突和最小审计。
- M2.2 社区治理后台：Staff/Admin 可查看社区域全状态帖子、冻结快照、保留媒体、举报、用户资料/备注/特别关注，并执行精选、下架/恢复、举报处理和 Admin 删除；关键写操作有事务、幂等、版本冲突保护和审计。

### 3. 进行中、未完成与当前卡点

- M1 team-test/生产仍为 No-Go：尚未创建或接入 R2、托管 PostgreSQL、Railway、Resend、Google OAuth、DNS 或线上部署；必须先完成费用、预算上限、停止/删除方案并取得业务 Go。
- 真实邮件投递和真实 Google OAuth 尚未配置或验收；本机 outbox/Mock 不能代替真实环境验证。
- M2 用户能力已合并但需要以当前后端代码重新启动服务，补做完整真实 HTTP/浏览器联调；单个专项测试通过不等于跨仓库验收。
- M2.1-B 公开内容尚未实现：公开文章列表/详情、审核发布状态机、sitemap、canonical/JSON-LD、公开分享、视频块和 MCP 服务身份均未完成。
- M2.2 前端后台页面与公开内容联调未完成；运营通知目前只返回未配置状态，社区媒体/冻结快照争议保留及物理清理调度尚未实现。
- M3 材料包/按图计数人工订单、M4 定制成品服务均未开始，须遵守各自 Spec 的阶段门禁，不得提前实现支付、自动物流或自动报价。
- 色号治理仍有业务依赖：美国市场品牌/色表来源未确认，现有“漫漫 S4”存在一号对应两个 HEX 的歧义；导入必须预检拦截，不能猜测映射。

### 4. 后续待开发任务（优先级）

1. **P0：完成 M2 用户能力剩余 QA 与契约联调**——以当前 HEAD 建立可观察、可回收的服务，跑完认证、作品、图纸册、社区、库存的 HTTP/浏览器矩阵，确认前后端契约版本并记录验收。
2. **P0：完成 team-test 准入准备**——业务确认测试账号、域名/DNS、发件域、预算和供应商；实现/验证私有 R2、受控迁移发布、清理 Cron/Pre-deploy、反向代理和真实邮件/Google OAuth 门禁。未获 Go 不创建云资源。
3. **P1：实现 M2.1-B 公开内容链路**——文章审核/发布/排期/归档、公开安全投影、SEO/GEO 元数据、sitemap、分享和受控品牌视频；随后与前端联调并补自动化测试。
4. **P1：完成 M2.2 运营前端与通知/保留策略**——后台管理页面、举报处理演练、运营通知、社区媒体与冻结快照保留/清理策略。
5. **P2：实施 M3 人工订单**——先冻结供应链 SOP、地址地域规则、报价/通知口径，再做材料清单快照、权限审计和一次端到端人工履约演练。
6. **P2：实施 M4 定制成品服务**——在 M3 有可履约证据后，建设私密需求、人工审核报价、文件权限、状态与通知，并完成成本/毛利复盘。
7. **P3：上线准备与运营化**——生产监控、备份恢复演练、数据保留策略、隐私/条款/退款文案、注册开放策略和发布回滚演练。

### 5. 目录结构说明

```text
.
├── AGENTS.md                         # 本工作区规则与项目交接摘要
├── docs/workspace/                   # 全局工作台、SOP、踩坑与复利日志
└── projects/project-001-拼豆后端/
    ├── README.md                     # 项目总览、状态、验收与协作边界
    ├── docs/                         # specs、接口契约、决策、复用评估、验收记录
    ├── handoff/                      # M0/M1/M1.1/M2 阶段交接包
    ├── src/service/
    │   ├── src/app/api/v1/           # Next.js API 路由
    │   ├── src/auth/                 # Better Auth、会话、CORS/CSRF、邮件
    │   ├── src/collections/           # Payload Users/Works/Content 等集合
    │   ├── src/works/                 # 作品创建、更新、删除、清理与幂等
    │   ├── src/inventory/             # 豆仓账本、导入、扣减、色号映射
    │   ├── src/library/               # 图纸册、文件夹、标签、收藏
    │   ├── src/community/             # 社区公开能力与治理服务
    │   ├── src/content/               # 官方内容草稿服务
    │   ├── src/assets/                # 文件校验与上传确认
    │   ├── src/storage/               # local/R2 对象存储适配器
    │   ├── src/migrations/             # 显式数据库迁移及回滚
    │   └── src/scripts/                # 清理、迁移和 team-test 脚本
    │   ├── tests/int/                 # Vitest 集成/接口测试
    │   ├── package.json               # 命令、版本和依赖
    │   ├── Dockerfile                 # standalone 生产镜像
    │   └── docker-compose.yml         # 本机 PostgreSQL
    ├── data/raw/                      # 可追溯、非敏感测试输入
    └── data/processed/                # 非敏感处理结果
```

### 6. 已知问题与注意事项

- 根目录与服务目录的 `AGENTS.md` 规则都必须遵守；服务目录中的 Next.js 规则要求写代码前查阅对应 `node_modules/next/dist/docs/` 指南。
- 后端与 `/Users/alexwork/Documents/PixoMosaic` 是独立仓库；不得通过复制前端代码、读取内部状态或直接修改前端来替代接口契约联调。
- 当前工作区原有的库存阈值注释/类型排序等 7 个已修改文件属于本次后端交付范围；`.playwright-cli/`、`.playwright-mcp/` 是本地临时目录，不能提交。
- 本机 Docker Compose 的 PostgreSQL 使用 localhost `trust`，只适用于无真实用户数据的本机验证；team-test/生产必须使用独立托管数据库和密钥管理。
- 禁止重新开启 Payload 自动 schema push；数据库结构只能通过显式迁移，发布前必须检查迁移状态并准备回滚路径。
- 不要把 `storageKey`、原图、邮箱、会话、Token、IP 原文、内部备注或真实凭据写入日志、文档、测试输出或公开 API；公开投影必须由服务端派生并默认 `no-store`。
- 本机测试通过、健康检查通过或单仓库构建成功，都不代表真实邮件、真实 OAuth、team-test、生产或前后端完整联调已通过。
- 发布前只暂存当前任务文件，检查 `git diff --check`、敏感信息扫描、迁移状态和测试结果；未经明确授权不要自动删除分支/工作树或重置历史。
