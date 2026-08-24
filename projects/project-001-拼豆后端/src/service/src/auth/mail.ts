// 文件开头说明：M1 认证邮件只经这一层投递。local 使用进程内测试 outbox；
// team-test 才允许通过 Payload 官方 Resend 适配器发送。不得在此记录或输出 OTP、
// 重设 token、完整收件人地址或第三方凭据。
import { resendAdapter } from '@payloadcms/email-resend'
import type { EmailAdapter, SendEmailOptions } from 'payload'

import { runtimeConfig } from '@/config/runtime'

export type LocalMailMessage =
  | {
      kind: 'email-verification-otp'
      email: string
      otp: string
    }
  | {
      kind: 'password-reset'
      email: string
      token: string
      url: string
    }

type AuthMailMessage = LocalMailMessage

type PayloadMailSender = (message: SendEmailOptions) => Promise<unknown>

const localMailOutbox: LocalMailMessage[] = []
let payloadMailSender: PayloadMailSender | null = null

export const getLocalMailOutbox = (): readonly LocalMailMessage[] => localMailOutbox

/**
 * 仅供本机浏览器手动验证读取最新的验证码。调用方必须先在路由层确认 local
 * 环境、回环服务地址和受信前端来源；此处不写日志、不持久化，也不适用于重设令牌。
 */
export const getLatestLocalEmailVerificationOtp = (email: string): string | null => {
  const normalizedEmail = email.trim().toLowerCase()

  for (let index = localMailOutbox.length - 1; index >= 0; index -= 1) {
    const message = localMailOutbox[index]
    if (message?.kind === 'email-verification-otp' && message.email.trim().toLowerCase() === normalizedEmail) {
      return message.otp
    }
  }

  return null
}

export const clearLocalMailOutbox = (): void => {
  localMailOutbox.length = 0
}

// Payload initializes its adapter before invoking this hook. Keeping the sender
// registration here avoids duplicating Resend REST calls in Better Auth callbacks.
export const registerPayloadMailSender = (sender: PayloadMailSender): void => {
  payloadMailSender = sender
}

const createLocalOutboxAdapter = (): EmailAdapter => () => ({
  name: 'pixomosaic-local-outbox',
  // runtime.ts permits this transport only in local, where both values are
  // supplied by the harmless local defaults.
  defaultFromAddress: runtimeConfig.mail.fromAddress!,
  defaultFromName: runtimeConfig.mail.fromName!,
  // Better Auth calls sendAuthMail directly in local mode. This adapter only
  // prevents Payload from falling back to console logging if a future internal
  // operation sends mail during local verification.
  sendEmail: async () => undefined,
})

export const createPayloadEmailAdapter = (): EmailAdapter => {
  if (runtimeConfig.mail.transport === 'local-outbox') {
    return createLocalOutboxAdapter()
  }

  return resendAdapter({
    apiKey: runtimeConfig.mail.resendApiKey!,
    defaultFromAddress: runtimeConfig.mail.fromAddress!,
    defaultFromName: runtimeConfig.mail.fromName!,
    ...(runtimeConfig.mail.overrideRecipient ? { overrideRecipientAddress: runtimeConfig.mail.overrideRecipient } : {}),
  })
}

const toPayloadEmail = (message: AuthMailMessage): SendEmailOptions => {
  if (message.kind === 'email-verification-otp') {
    return {
      subject: '[PixoMosaic Team Test] 验证邮箱',
      text: `你的 PixoMosaic 验证码是：${message.otp}。验证码将在 15 分钟后失效。`,
      to: message.email,
    }
  }

  return {
    subject: '[PixoMosaic Team Test] 重设密码',
    text: `请使用此链接重设 PixoMosaic 密码：${message.url}`,
    to: message.email,
  }
}

export const sendAuthMail = async (message: AuthMailMessage): Promise<void> => {
  if (runtimeConfig.mail.transport === 'local-outbox') {
    // The outbox is test-only. Its tokens never enter audit logs, console logs,
    // project files, or a deployment process.
    localMailOutbox.push(message)
    return
  }

  if (!payloadMailSender) {
    throw new Error('认证邮件适配器尚未初始化，拒绝发送邮件。')
  }

  await payloadMailSender(toPayloadEmail(message))
}
