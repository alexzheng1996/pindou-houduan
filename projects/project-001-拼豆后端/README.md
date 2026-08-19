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

已于 2026-08-18 立项。**M0 技术基础已完成，M1 本地账号基础已开始；现在先完成本地最小功能与验证，云端 team-test 只在部署前检查、费用说明和业务方再次确认后才创建。**

- 已固定 Node `24.19.0`、pnpm `10.33.2`、Payload 与 PostgreSQL 适配器 `3.88.0`，并完成本地 PostgreSQL、显式迁移、`/health`、自动化测试与 Docker 生产模式健康检查。
- M1 的 `/api/v1` 交换规则和 `WorkDocument` v1 数据契约已冻结为工程基线；尚未做真实前端往返联调。
- M1 本地基础已加入用户角色、账号状态、认证来源、条款字段、邮箱验证参数、登录失败锁定、Cookie/CORS/CSRF 边界和显式数据库迁移；尚未实现注册、作品、邮件发送或 Google 回调。
- 主域名已确认是 `pixomosaic.com`；未创建云账号、对象存储桶、邮件账号、OAuth、`api-test.pixomosaic.com` DNS 记录或线上部署，也不需要 Cloudflare 凭据；未修改 PixoMosaic 前端仓库。
- 完整验收证据和 M1 进入条件见 `docs/验收/阶段验收记录.md` 与 `handoff/M0-技术基础完成与M1-Go清单.md`。

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
- `docs/specs/01-M0-基础架构与M1接口冻结-spec.md`：M0-A / M0-B 的实施范围与验收。
- `docs/接口/M1-作品数据契约.md`：单图图纸和画板云端作品的 v1 字段、文件与兼容边界。
- `docs/实施准备/M0-本机环境与云端账号清单.md`：M0 本地基础的复现方式，以及 M1 前要确认的账号权限。
- `docs/决策/M0-团队验证供应商与权限决策.md`：团队验证环境的推荐组合、账号最小权限、预算确认点和不开户边界。
- `docs/实施准备/M1-team-test-部署前检查与费用Go.md`：本地完成后的费用、停止/删除方案和 team-test 创建授权检查。
- `docs/复用评估/M1-认证方案核查.md`：Google 登录的成熟方案评估与 PoC 门禁。
- `handoff/M0-技术基础完成与M1-Go清单.md`：给总调度和业务方的 M0 收口、M1 Go/No-Go 清单。

## 运行或验证方式

在项目服务目录内执行以下命令，可复核 M0 本地基础：

1. `fnm exec --using ../../.node-version pnpm install --frozen-lockfile`
2. `docker compose up -d postgres && fnm exec --using ../../.node-version pnpm migrate:status`
3. `fnm exec --using ../../.node-version pnpm lint && fnm exec --using ../../.node-version pnpm test && fnm exec --using ../../.node-version pnpm build`

开发服务仅监听本机：`fnm exec --using ../../.node-version pnpm dev`，再访问 `http://127.0.0.1:3000/health`。不得用当前机器的 Node 25 代替项目基线；不得在没有 M1 Go 的情况下创建或连接任何团队/生产云资源。

## 验收标准

- 后端边界、接口契约、数据责任和错误处理可被 PixoMosaic 前端据此联调。
- M0 的后端基础具备自动化测试和可追溯验证记录；M1 的功能测试、真实前端联调和团队环境演练尚未开始。
- 所有项目相关文件均在本项目目录内，不依赖复制前端仓库文件。

## 与 PixoMosaic 的协作边界

- 前端仓库：`/Users/alexwork/Documents/PixoMosaic`。
- 后端仓库：当前 Workspace。
- 协作媒介：本目录 `docs/前后端接口契约.md` 中的版本化契约和联调记录。
- 未经用户明确授权，后端任务不得修改 PixoMosaic 仓库。

## 关键结论与复盘

- 当前最重要的前置是完成 M1 环境的业务 Go：业务方持有并确认测试账号、域名/DNS、发件域和预算；技术基础不等于已获准上线。
- 任何跨仓库协作都应以接口和验收记录连接，避免以共享文件路径或复制代码耦合。
