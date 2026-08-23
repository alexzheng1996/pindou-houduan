# PixoMosaic 后端服务（M0 + M1 本地基础）

> 状态：M0 技术基础与 M1 本地账号、私密 `pattern` / `board` 作品、受控文件、删除回收、审计反滥用和 Google 本机 OIDC Mock 均已完成。本服务尚未实现真实邮件、真实 Google OAuth、真实前端联调或团队/生产环境部署。

## 作用与边界

- 技术基线：Node `24.19.0`、pnpm `10.33.2`、Payload/`@payloadcms/db-postgres` `3.88.0`、PostgreSQL 16。
- 仅本机开发接口：`GET http://127.0.0.1:3000/health`。开发服务只监听 `127.0.0.1`；健康检查不会返回连接串、用户信息或异常原文。
- 本地数据库容器仅绑定 `127.0.0.1:55440`，不得写入真实用户、订单、地址或文件。
- M0 已关闭 GraphQL；Payload 默认 REST/Admin 面不是 PixoMosaic 前端的业务契约。M1 只会实现文档定义的 `/api/v1`。
- M1 本地基础已固定 `user/staff/admin` 角色、账号状态、认证来源、条款字段、邮箱验证、登录失败锁定和 Cookie/CORS/CSRF 环境边界；数据库变更通过 `20260818_232836_m1_user_account_fields` 显式迁移。
- Google 登录复用 `payload-auth + better-auth` 的 `generic-oauth` 能力。本机 Mock 已覆盖协议校验与显式绑定；默认 `GOOGLE_OAUTH_MODE=disabled`，真实 Google OAuth client、回调 URI 与密钥仍未配置。具体边界见 `../../docs/specs/02c-M1-Google本地OIDC-Mock-spec.md`。
- 本服务尚未满足 team-test 的真实邮件、真实前端联调、反向代理/IP 边界与部署演练要求；已完成的 A/B 私有资源隔离和 M1 本地权限自动化测试不能替代该门禁。

完整架构、接口和阶段门禁位于项目上层 `README.md`、`docs/specs/` 与 `docs/接口/`。

## 本机复现

从本目录执行。不要使用当前 shell 默认的 Node 25，始终通过项目固定的 Node 24 运行：

```bash
fnm exec --using ../../.node-version pnpm install --frozen-lockfile
docker compose up -d postgres
fnm exec --using ../../.node-version pnpm migrate:status
fnm exec --using ../../.node-version pnpm dev
```

另开终端检查：

```bash
curl --fail http://127.0.0.1:3000/health
```

预期响应为：

```json
{"status":"ok"}
```

## 验证与构建

```bash
fnm exec --using ../../.node-version pnpm lint
fnm exec --using ../../.node-version pnpm test
fnm exec --using ../../.node-version pnpm build
fnm exec --using ../../.node-version pnpm audit --prod
docker build -t pixomosaic-backend:m0-local .
```

数据库结构只能由显式迁移命令更新：

```bash
fnm exec --using ../../.node-version pnpm migrate
fnm exec --using ../../.node-version pnpm migrate:status
```

禁止重新开启 Payload 的自动 schema push。它会令迁移历史与数据库产生分歧，使以后团队和生产发布需要人工确认。

## 配置与安全

- 复制 `.env.example` 建立仅本机使用的 `.env`；它已被 Git 忽略。不得把 `.env`、连接串、密钥、令牌或真实邮件地址写入 Git、日志或文档。
- `docker-compose.yml` 的 `trust` 仅允许用于 localhost 的无用户数据 M0 数据库。team-test/production 必须使用供应商托管的独立数据库和受保护密钥。
- Docker 镜像不应包含 `.env`、数据库卷或用户文件；团队环境与生产环境使用独立数据库、对象存储桶、邮件配置和密钥。

## M1 本地与部署前门禁

- 本机受控文件 API 已提供 `upload-intent → PUT → confirm → 私有 GET`：只接受 PNG/JPEG/WebP，单文件 15 MiB、每作品 10 张/100 MiB、每用户 2 GiB；字节特征、图片解码、SHA-256、归属和状态均由服务端再校验。响应不含存储键、磁盘路径或公开 URL。
- 本机对象目录是 Git/Docker 忽略的 `data/local-object-store/`，只用于自动化验证；其底层适配器将由 R2/S3 私有桶替换，不能直接带入部署。
- Google Mock 仅由 `pnpm test` 的 Vitest 测试进程在 `127.0.0.1:55441` 临时启动。正常 `dev` / `start` 不会启动它，也不应把 `GOOGLE_OAUTH_MODE=mock` 带入任何部署环境。
- 邮件投递统一经过本项目的认证邮件层：local 只写进测试 outbox；仅获批的 team-test 才能设 `MAIL_TRANSPORT=resend` 并使用官方 `@payloadcms/email-resend`。真实凭据只保存于部署平台密钥配置，细则见 `../../docs/specs/02d-M1-真实邮件适配器准备-spec.md`。

M1 已完成注册、作品、上传模拟、邮件模拟、Google 本机 OIDC Mock、权限和反滥用的本地验证，不创建云资源或 DNS。下一步先准备真实邮件适配器的可替换接口，再进行只读契约核对和前端联调；仅当全部本地功能、迁移、自动化测试和 Docker 部署检查通过后，才向业务方说明当日费用、免费额度、预算上限与停止/删除方案，并请求创建 team-test 的授权。

主域名已确认是 `pixomosaic.com`。Railway 实际分配域名后，由业务方自行添加 `api-test.pixomosaic.com` CNAME；当前不需要 Cloudflare 密码或 API Token。完整门禁见 `../../docs/实施准备/M1-team-test-部署前检查与费用Go.md`。
