# M0 技术基础完成与 M1 Go 清单

> 给业务方与后续总调度使用。状态截至 2026-08-19：M0 技术基础完成；M1 本地账号基础已获确认，但未获云资源创建授权。

## 已完成并验证

| 项目 | 结果 |
| --- | --- |
| 运行基线 | 项目固定 Node `24.19.0`、pnpm `10.33.2`、Payload/PostgreSQL 适配器 `3.88.0`。 |
| 本地数据库 | PostgreSQL 16 容器仅绑定 `127.0.0.1:55440`，没有真实用户数据。 |
| 迁移 | 仅通过显式迁移运行；初始迁移 `20260818_161323_init_users` 已运行。Payload 自动 schema push 已禁用。 |
| 服务健康 | `/health` 可在本地和 Docker 生产模式返回 `200 {"status":"ok"}`。 |
| 攻击面 | GraphQL、GraphQL Playground、模板 Media 和示例路由已移除/关闭；开发服务仅监听本机，未返回技术指纹。 |
| 验证 | `pnpm lint`、`pnpm test`（1 passed）、`pnpm build`、`pnpm audit --prod`（0 vulnerabilities）、`pnpm migrate:status`、Docker 生产模式健康检查均通过。 |
| 接口基线 | `/api/v1` 规则和 `WorkDocument` v1 已冻结为 M1 实现输入；真实前端往返联调尚未进行。 |
| M1 本地账号基础 | 已加入角色、账号状态、认证来源、条款字段、邮箱验证/登录锁定参数、Cookie/CORS/CSRF 边界；显式迁移和 5 个基础测试已通过。 |

## 已确定的 M1 业务边界

- 邮箱密码注册、邮箱验证、登录、忘记/重设密码；Google 登录另行做小范围安全评审。
- 每用户最多 50 个 active 私密作品；删除进入 30 天回收期；后端参与登录、上传、作品写入和导出的反滥用。
- `WorkDocument` 是 PostgreSQL 中唯一可编辑真值；`WorkAsset.role=document` 只可作为归档副本。
- 首次保存固定为：创建 draft → 上传授权 → 确认资产 → 写入完整文档并激活。
- 容量基线：单图/单层 90,000 格，画板最多 20 层/总 180,000 格，解码后请求体最大 8 MiB。
- PixoMosaic 前端仓库不在本项目改动范围内；通过版本化接口契约协作。

## 仍未执行（不是技术遗漏）

- 未创建 Neon、R2、Resend、Railway、Google OAuth、域名/DNS 或任何云端资源。
- 未部署 team-test 或生产环境；未开放注册；未发送真实邮件；未创建真实用户或作品。
- 未实现 M1 的账号、作品、上传、权限、删除、反滥用和 Admin/Staff 功能。
- 未做真实前端的 `pattern`/`board` 往返联调。

## 业务方已确认的 M1 决策

- [x] 采用 `Neon + Cloudflare R2 + Resend + Railway`；详见 `docs/决策/M0-团队验证供应商与权限决策.md`。
- [x] Google 登录列入 M1；邮箱密码注册/验证/重设仍为基础路径。

## team-test 延后创建（已确认）

- [x] 主域名为 `pixomosaic.com`。
- [x] 当前不创建 Railway、Neon、R2、Resend 等 team-test 云资源，不添加 `api-test.pixomosaic.com` DNS 记录，也不需要 Cloudflare 密码或 API Token。
- [x] team-test 只用于邀请/白名单团队验证，不开放公开注册。
- [ ] 本地 M1 最小功能与部署前检查通过后，再由业务方确认预算上限、区域、测试邮箱/发件域和资源创建授权。
- [ ] Railway 实际分配域名产生后，由业务方自行添加 `api-test.pixomosaic.com` CNAME。

在上述条件满足前，只推进本地数据库、账号模型、权限测试、API 实现和脱敏样本验证；不创建云资源、不绑定 DNS、不发送真实邮件。部署前费用和停止/删除方案见 `docs/实施准备/M1-team-test-部署前检查与费用Go.md`。

## 总调度收到 Go 后的第一批任务

1. [已完成基础] 在本地建立隔离的用户角色、邮箱验证和会话参数；Google OAuth 已完成成熟方案核查，候选为 `payload-auth + better-auth`，等待 PoC 后安装。
2. 依据 M1 Spec 实现用户角色、权限边界、邮箱密码流程和邀请/白名单注册；先写 A/B 用户隔离测试。
3. 实现 Work、WorkDocument、WorkAsset、保存时序、50 个上限和私有 R2 上传；每项以自动化测试验收。
4. 用脱敏 `pattern` 与 `board` 样本做 API/前端往返联调，记录前端版本、环境、结果和已知限制。
5. 完成团队演练：注册、跨设备读取、删除恢复、越权拒绝、邮件与后台审计；再由业务方决定是否进入 M2 或开放生产注册。

## 不可跳过的安全门禁

- 普通用户不能进入 Admin；A 用户不能读取、下载、修改或删除 B 用户的作品或资产；Staff/Admin 权限必须有自动化测试。
- 对象存储保持私有，不返回对象键或永久原图链接；上传/下载短期授权仍须先检查作品归属。
- 密钥、数据库 URL、邮件 API Key、OAuth Secret、用户文件和真实用户数据不进入 Git、文档、日志或测试样本。
- 每次模型变更必须新增显式迁移；不得重新开启 Payload 自动 schema push。
