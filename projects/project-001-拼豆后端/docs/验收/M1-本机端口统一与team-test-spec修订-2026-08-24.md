# M1 本机端口统一与 team-test Spec 修订验证

> 日期：2026-08-24。本文只记录本机端口、环境门禁和 Spec 可执行性修订的验证结果；不代表 R2、Railway、Neon、Resend、Google OAuth、DNS 或完整 team-test 已创建或验收。

## 结论

本机端口口径已统一，后端可在 `3002` 启动并接受 PixoMosaic 两个前端来源；`3000` 不再属于本项目。Docker 会在 `APP_ENV` 未显式设置为合法值时拒绝启动，避免部署漏配后降级为 local。

| 角色 | 地址或规则 |
| --- | --- |
| 后端本机 API | `http://127.0.0.1:3002` |
| PixoMosaic 单图前端 | `http://127.0.0.1:3050` |
| PixoMosaic 画板/豆仓前端 | `http://127.0.0.1:3100` |
| `3000` | 不属于本项目，当前由其他本机服务占用 |
| Railway | 只使用平台注入的动态 `PORT`，健康检查路径为 `/health` |

## 已实施内容

- 后端 `dev` / `devsafe` / `start` 默认端口统一为 `3002`；运行时默认认证基地址同步为 `3002`。
- local 环境自动允许 `3050` 与 `3100` 作为 CORS/CSRF/Better Auth 可信来源；`3000` 不再被加入白名单。
- Docker 默认 `PORT=3002`，健康检查读取运行期 `PORT`；runner 默认使用非法 `APP_ENV` 哨兵，未显式传入 `local` 或 `team-test` 时以退出码 `64` 终止。
- `02f` Spec 已纳入外部复核中合理的 P1/P2 项：环境 fail-closed、Railway Pre-deploy 可执行迁移、R2 失败补偿、R2 Token 权限口径、单一 Cron、动态端口与当前迁移清单。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| `pnpm lint` | 通过 |
| `pnpm test` | 12 个文件、49 项测试通过 |
| `pnpm build` | 通过 |
| `pnpm audit --prod --audit-level=high` | 未发现已知漏洞 |
| `git diff --check` | 通过 |
| 本机 `GET 3002/health` | `200 {"status":"ok"}` |
| `OPTIONS /api/v1/works`，来源 `3050` | `204`，返回对应 `Access-Control-Allow-Origin` |
| `OPTIONS /api/v1/works`，来源 `3100` | `204`，返回对应 `Access-Control-Allow-Origin` |
| `OPTIONS /api/v1/works`，来源 `3000` | `403` |
| Docker 构建 | 通过，标签 `pixomosaic-backend:port-3002-env-guard` |
| Docker 未设置 `APP_ENV` | 以退出码 `64` 终止，不启动 Web |
| Docker `APP_ENV=local`、自定义 `PORT=4012` | `/health` 返回 `200` |

## 仍未完成

- 私有 R2 适配、最终镜像内迁移/清理命令、真实 Railway Pre-deploy/Cron。
- 任何云资源、DNS、真实邮件或 OAuth 配置。
- team-test/生产完整前后端联调。
