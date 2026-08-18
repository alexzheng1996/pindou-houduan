# PixoMosaic 后端服务（M0 基础）

> 状态：M0 技术基础已完成。本服务只证明 Payload + PostgreSQL 的本地与容器基础可用；它尚未实现用户注册、云端作品、上传、邮件、OAuth 或任何可对外使用的业务 API。

## 作用与边界

- 技术基线：Node `24.19.0`、pnpm `10.33.2`、Payload/`@payloadcms/db-postgres` `3.88.0`、PostgreSQL 16。
- 仅本机开发接口：`GET http://127.0.0.1:3000/health`。开发服务只监听 `127.0.0.1`；健康检查不会返回连接串、用户信息或异常原文。
- 本地数据库容器仅绑定 `127.0.0.1:55440`，不得写入真实用户、订单、地址或文件。
- M0 已关闭 GraphQL；Payload 默认 REST/Admin 面不是 PixoMosaic 前端的业务契约。M1 只会实现文档定义的 `/api/v1`。
- 本服务未满足团队环境权限要求。M1 必须补齐 User/Staff/Admin 权限和“用户 A 不能访问用户 B 资源”的自动化测试后才能部署 team-test。

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

## M1 前置条件

开始 M1 之前，业务方必须确认 team-test 的 PostgreSQL、R2/S3、邮件、托管与 DNS 主账号、预算上限和最小权限。推荐组合与清单见 `../../docs/决策/M0-团队验证供应商与权限决策.md`。
