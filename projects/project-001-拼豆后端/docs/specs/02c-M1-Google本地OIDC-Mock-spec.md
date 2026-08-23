# Spec：M1 Google 本地 OIDC Mock

> 状态：本地实现与自动化验证完成。该 Mock 只证明 M1 对标准 OIDC 授权码流程的安全接入方式；它不连接 Google、不创建 Google Cloud OAuth client、不发送真实邮件，也不代表 team-test 或生产 Google 登录已经启用。

## 1. 目标

在不申请第三方账号、不保存真实 OAuth 凭据的前提下，验证 Google 登录接入必须满足的安全门禁：授权码、PKCE、state、nonce、ID Token 签名、issuer、audience 与已验证邮箱，以及本地账号的显式绑定规则。

## 2. 复用方案与边界

- 认证骨架复用已锁定的 `payload-auth@3.0.0`、`better-auth@1.7.1` 与其维护的 `generic-oauth` 插件；不手写 OAuth callback 或自行实现 Token 校验。
- 本机测试通过 Vitest 的 loopback 服务模拟 OIDC discovery、JWKS、授权端点和 token 端点。模拟服务仅绑定 `127.0.0.1:55441`，测试进程结束即关闭。
- 默认配置为 `GOOGLE_OAUTH_MODE=disabled`；只有测试进程设置为 `mock`。`mock` 只能用于 `APP_ENV=local`，运行时拒绝在 team-test 或生产启用。
- 未来真实接入只能设为 `GOOGLE_OAUTH_MODE=google`，并由部署平台密钥配置提供 `GOOGLE_OAUTH_CLIENT_ID` 与 `GOOGLE_OAUTH_CLIENT_SECRET`。不得写入代码、`.env.example`、文档、日志或 Git。

## 3. 已实现的安全规则

1. 登录使用标准授权码 + PKCE（S256）流程；授权码一次消费且有 5 分钟有效期。
2. OIDC discovery 与 JWKS 验证 ID Token 的 RS256 签名、issuer、audience、nonce；任一不匹配即拒绝，不创建账户或会话。
3. 只有 `email_verified=true` 的 Google 身份才可创建并激活本地账户。
4. `disableImplicitLinking=true`：Google 身份与同邮箱的既有本地账号不得静默合并。用户必须先登录本地账户，再通过 `/api/v1/auth/link-social` 明确绑定。
5. Google 回调只写固定的审计动作、结果、请求 ID 和受控原因码；不记录 code、state、ID Token、access token、邮箱、完整回调 URL 或 provider profile。
6. Google 登录发起和显式绑定各沿用独立数据库限流：`10 次 / 10 分钟`。本机 Mock 不使用真实 Google 配额。

## 4. 自动化验收

- [x] 正常路径：通过授权码、PKCE、state、nonce、签名、issuer、audience 后，创建已验证且 active 的 Google 本地会话。
- [x] 拒绝路径：错误 issuer、audience、nonce 或 `email_verified=false` 时，不创建账户或会话。
- [x] 账号绑定：同邮箱本地账号的非登录 Google 流程被拒绝；仅已登录用户的显式绑定可关联 Google 账户。
- [x] 审计：Google 回调成功/拒绝仅保留固定事件，不含 OAuth 凭据或个人内容。

验证入口：`src/service/tests/int/m1-google-oauth-mock.int.spec.ts`；Mock 实现：`src/service/tests/int/mock-google-oidc.global-setup.ts`。

## 5. 不代表完成的事项与 team-test 门禁

- 未创建 Google Cloud 项目、OAuth consent screen、OAuth client、回调 URI 或任何密钥。
- 未验证 Google 的真实授权页、真实账户、生产 Cookie/CORS、品牌/隐私披露、发布状态或第三方配额政策。
- team-test 仍须先完成真实邮件适配器、前端联调、Docker/部署前检查与当日费用说明；获得业务方当次 Go 后，才可创建资源并登记实际 Google 回调 URI。
- team-test 只允许邀请/白名单注册，不能因本 Spec 通过而开放公开注册。

## 6. 回滚与维护

- 默认 `disabled` 不加载 Google provider；删除测试环境变量后不会保留 Mock 服务或 OAuth 配置。
- 本次不新增数据库迁移；Better Auth 账户表来自既有受控迁移。未来若变更 provider、绑定规则或回调域名，必须先更新本 Spec、接口契约和测试，再请求 team-test 配置变更。
