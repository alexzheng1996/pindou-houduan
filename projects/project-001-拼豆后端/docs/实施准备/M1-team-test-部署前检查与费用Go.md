# M1 team-test 部署前检查与费用 Go

> 状态：**当前不执行。**本文件是本地 M1 最小功能完成后、向业务方请求创建云资源前必须补齐的检查单。
>
> 已确认主域名：`pixomosaic.com`。当前不创建 Railway、Neon、Cloudflare R2、Resend 或 Google OAuth 资源；不添加 `api-test.pixomosaic.com` DNS 记录；不需要 Cloudflare 密码或 API Token。

## 目的

避免在注册、作品、上传、邮件和 Google 登录尚未完成时，为长期运行的 team-test 服务付费。只有本地功能和部署检查都通过，且业务方阅读费用、免费额度、预算上限和停止/删除方案后明确 Go，才允许创建资源。

## 前置通过项

- [x] 邮箱注册、验证、登录、登出、重设密码和本地环境注册策略完成 API 与自动化测试。team-test 白名单需在创建前以受控测试邮箱单独填写。
- [x] Google 登录本地 PoC 完成：模拟回调、会话、账号不隐式绑定、ID Token 核验与显式绑定验证通过；真实 Google OAuth client 与回调 URI 尚未创建。
- [x] Work / WorkDocument / WorkAsset、50 个作品上限、上传边界、删除回收、A/B 隔离、本地限流与最小审计自动化测试通过；team-test 前仍须确认可信代理、IP/边缘层限制、阈值和保留期。
- [x] 文件与邮件的本地受控模拟已验证；官方 Resend 适配器已接入受环境门禁保护的投递层，没有真实用户文件、邮箱名单或凭据进入 Git、日志或测试样本。
- [ ] 真实邮件适配器与受控测试邮箱发送演练：须在 Resend team-test 资源、发件域、最小权限密钥、`REGISTRATION_ALLOWLIST` 和费用 Go 齐备后执行；首次须设置单一 `RESEND_OVERRIDE_RECIPIENT`。
- [x] `pnpm lint`、类型检查、`pnpm test`、`pnpm build`、迁移状态、生产依赖审计和 Docker 部署检查已通过；team-test 前对最终候选镜像重跑。
- [x] 已完成前端数据与 API v1 的字段映射核对，并以本机真实浏览器完成 Cookie/CORS、作品、豆仓和制作扣减闭环；本地草稿/Data URL 不能直接上传。该验证不等同于 team-test/生产完整前后端联调。

## 当日费用说明（由总调度重新核实）

总调度必须在创建前，以各供应商官网账单页和目标区域的实际信息填写下表；不得沿用旧报价或在文档中猜测价格。

| 资源 | 用途与最小规格 | 当日免费额度/试用 | 预估月费用 | 超额触发点 | 业务方预算上限 | 停止方式 |
| --- | --- | --- | --- | --- | --- | --- |
| Neon | team-test PostgreSQL | 待当日核实 | 待核实 | 容量、计算、分支/备份 | 待业务方确认 | 停止计算或删除测试项目；先导出/确认无需保留数据 |
| Cloudflare R2 | 私有测试文件桶 | 待当日核实 | 待核实 | 存储、读写、出口或关联服务 | 待业务方确认 | 停止应用写入，按生命周期清空对象，再删除测试桶和受限密钥 |
| Resend | 测试验证/重设邮件 | 待当日核实 | 待核实 | 邮件发送量、超出免费层 | 待业务方确认 | 禁用/撤销测试 API Key，停止发送，移除测试发件配置 |
| Railway | Docker 应用服务 | 待当日核实 | 待核实 | 运行时长、CPU、内存、网络和卷 | 待业务方确认 | 暂停或删除服务；确认无应用卷存放用户文件或数据库 |
| Google OAuth | 仅在本地 PoC 后接入 | 待当日核实 | 待核实 | 一般不按调用收费，仍须核实配额与政策 | 待业务方确认 | 删除测试 OAuth client、撤销重定向 URI 和密钥 |

官方核对入口：

- [Neon Pricing](https://neon.com/pricing)
- [Cloudflare R2 Pricing](https://developers.cloudflare.com/r2/pricing/)
- [Resend Pricing](https://resend.com/pricing)
- [Railway Pricing](https://railway.com/pricing)

## 创建顺序与 DNS 边界

1. 业务方审核上表并明确本次 team-test 的月度预算上限、区域和创建授权。
2. 创建隔离的 Neon、R2、Resend、Railway team-test 资源和最小权限变量；不使用生产账号、生产用户数据或共享密钥。
3. 在 Railway 部署受控 Docker 镜像，通过健康检查，记录 Railway **实际分配域名**。
4. 由业务方自行在 Cloudflare 添加 `api-test.pixomosaic.com` 指向该实际 Railway 域名的 CNAME；当前阶段不索取密码、API Token，也不代为写入 DNS。
5. DNS 和 HTTPS 生效后，填写受控 CORS/CSRF 来源、Cookie 域、Google 回调 URI 和测试发件域验证记录。
6. 只开放邀请/白名单测试注册，完成团队演练；不开放公开注册。

## 停止、删除与回收方案

如果测试暂缓、费用超过上限、发现权限风险或业务方要求停止，按以下顺序处理：

1. 立即关闭公开入口和邀请发放，暂停 Railway 服务，阻断新的登录、上传和邮件发送。
2. 导出必要的脱敏审计与验收记录；不导出不必要的用户文件或凭据。
3. 停用 Resend 测试 Key、删除 Google OAuth 测试 client 或回调配置、撤销 R2 最小权限密钥。
4. 确认 30 天回收或法律保留要求后，清空 R2 测试对象，删除测试桶；删除 Railway 服务、Neon 测试项目/分支和相关备份。
5. 由业务方确认账单页不再有运行资源或预留付费项；在阶段验收记录中写明停止时间、删除范围和仍保留的非敏感交接物。

以上删除动作均需业务方在当时明确授权；不得将 team-test 当作生产备份。

## Go / No-Go 记录

| 项目 | 结论 |
| --- | --- |
| 本地 M1 核心功能和验证 | 已完成；已完成本机浏览器 HTTP 技术验证；真实邮件、真实 Google OAuth、team-test/生产完整联调仍待完成 |
| 当日价格、免费额度与区域核实 | 待执行 |
| 预算上限 | 待业务方确认 |
| team-test 创建授权 | 待业务方确认 |
| Railway 实际域名 | 创建后记录 |
| Cloudflare CNAME | Railway 域名确认后由业务方执行 |
| 公开注册 | 禁止；仅邀请/白名单 |
