# Spec：M1 真实邮件适配器准备

> 状态：本地接口准备与回归验证完成。未创建 Resend 账号、API Key、发件域 DNS 或测试收件箱；未发送任何真实邮件。真实投递只可在获批的邀请制 team-test 环境执行。

## 1. 业务目标

让邮箱验证与密码重设在未来 team-test 能可靠投递，同时保持当前本机开发零费用、零真实收件人、零凭据与可重复自动化测试。

## 2. 复用优先评估

| 候选 | 适配度 | 结论 |
| --- | --- | --- |
| Payload 官方 `@payloadcms/email-resend@3.88.0` | 高 | **采用**。与当前 `payload@3.88.0` peer 版本精确匹配，MIT；只复用其 Resend REST 投递适配，不复制实现代码。 |
| 自建 SMTP / Resend HTTP 调用 | 低 | 不采用。会重复处理鉴权、错误响应、升级兼容和测试，维护收益不足。 |
| 开发期真实 Resend | 低 | 不采用。会引入持续账号、发件域、收件人和费用管理，违背本地优先与 team-test Go 门禁。 |

官方适配器只负责把一封已决定发送的邮件投递给 Resend；它不替代一次性 OTP、重设令牌单次消费、账号状态、白名单、审计或退信运营处理。

## 3. 已实现的边界

- `MAIL_TRANSPORT=local-outbox` 是本机唯一允许的默认值。认证邮件只进入进程内测试 outbox，测试结束即消失，不打印到控制台或写入数据库、审计、项目文件。
- `MAIL_TRANSPORT=resend` 只允许 `APP_ENV=team-test`；必须在部署平台的密钥配置中提供 `RESEND_API_KEY`、`MAIL_FROM_ADDRESS`、`MAIL_FROM_NAME`。
- 可选 `RESEND_OVERRIDE_RECIPIENT` 可在首轮 team-test 强制把所有邮件改投到一个受控测试收件箱。它不是白名单替代品，注册仍由 `REGISTRATION_ALLOWLIST` 控制。
- 邮箱验证模板只包含 15 分钟 OTP；密码重设模板只包含一次性重设链接。邮件主题固定带 `[PixoMosaic Team Test]`，避免测试邮件被误认为正式通知。
- 认证回调只通过统一的 `sendAuthMail` 投递；不会把 token、OTP、完整邮箱、Resend 响应或 API Key 写进日志和审计。

## 4. 本地验证

- [x] 邮箱注册/OTP 验证与重设密码集成测试仍通过，且所有测试邮件只由 local outbox 接收。
- [x] Payload 不再使用未配置邮件适配器的 console fallback，避免测试将收件人或主题输出到控制台。
- [x] 类型检查、lint 与 37 项 M1 集成测试通过。
- [ ] 真实 Resend API 调用、发件域验证、投递/退信、受控收件箱与 DNS 记录：仅在 team-test 创建获得业务方当次 Go 后执行。

## 5. team-test 启用清单

1. 总调度在当日费用说明中补齐 Resend 免费额度、预计邮件量、预算上限和停止方式，并取得业务方 Go。
2. 创建**仅用于 team-test** 的 Resend 配置，验证测试发件域；密钥仅写入 Railway 的密钥配置，不进入 `.env`、文档、日志或 Git。
3. 配置 `APP_ENV=team-test`、`MAIL_TRANSPORT=resend`、`MAIL_FROM_ADDRESS`、`MAIL_FROM_NAME`、`RESEND_API_KEY`、`REGISTRATION_ALLOWLIST`，首轮设置 `RESEND_OVERRIDE_RECIPIENT`。
4. 用白名单测试账号演练注册、OTP、密码重设；核对邮件主题、收件人、有效期、重放失败与审计最小化。
5. 演练结束后移除 override 或暂停发送；若停止 team-test，先撤销 API Key，再删除发件配置，并按部署前检查记录收尾。

## 6. 不做事项

- 不在 M1 自建邮件队列、批量营销、订阅退订、营销模板、退信自动化或邮件分析平台。
- 不把“Resend 返回已受理”当成账号验证、密码重设或业务状态已完成；真正状态仍以用户完成 OTP/重设流程为准。
- 不在 team-test 前创建任何外部邮件资源，也不以本地 outbox 替代真实投递验收。
