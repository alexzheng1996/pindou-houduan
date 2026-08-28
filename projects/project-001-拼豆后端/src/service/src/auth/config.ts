// 文件开头说明：M1 认证配置只组合成熟的 Better Auth 能力，并把业务账户状态
// 与本地邮件 outbox 留在本项目。此处不读取或保存任何第三方 OAuth 凭据。
import type { CollectionConfig, DateField, SelectField } from 'payload'
import { emailOTP } from 'better-auth/plugins'
import { genericOAuth } from 'better-auth/plugins/generic-oauth'
import type { PayloadAuthOptions } from 'payload-auth/better-auth/plugin'

import { restrictAuthInternalCollection } from '@/auth/collections'
import { accountStatuses } from '@/collections/Users'
import { isRegistrationEmailAllowed, runtimeConfig } from '@/config/runtime'
import { sendAuthMail } from '@/auth/mail'

const emailVerificationExpiresInSeconds = 15 * 60
const passwordResetExpiresInSeconds = 60 * 60
const adminInvitationLifetimeMilliseconds = 7 * 24 * 60 * 60 * 1000

const googleOAuthPlugin =
  runtimeConfig.googleOAuth.mode === 'disabled'
    ? null
    : genericOAuth({
        // Use Better Auth's maintained generic OIDC provider rather than a
        // hand-written callback. Its discovery/JWKS path verifies signature,
        // issuer, audience and the authorization-request nonce before the
        // decoded profile can create or link a local account.
        config: [
          {
            providerId: 'google',
            name: runtimeConfig.googleOAuth.mode === 'mock' ? 'Google local mock' : 'Google',
            discoveryUrl: runtimeConfig.googleOAuth.discoveryUrl,
            requireIdTokenVerification: true,
            clientId: runtimeConfig.googleOAuth.clientId!,
            ...(runtimeConfig.googleOAuth.clientSecret
              ? { clientSecret: runtimeConfig.googleOAuth.clientSecret }
              : {}),
            scopes: ['openid', 'profile', 'email'],
            // A user must intentionally choose the Google sign-up action.
            // This is separate from account linking, which remains disabled
            // unless a logged-in user performs the explicit OAuth flow.
            disableImplicitSignUp: true,
            requireEmailVerification: true,
          },
        ],
      })

const getBetterAuthSecret = (): string => {
  const secret = process.env.BETTER_AUTH_SECRET?.trim()

  if (secret && secret.length >= 32) {
    return secret
  }

  // Next evaluates route configuration while producing the Docker image. The
  // builder marks only that compilation phase; the runner never receives this
  // marker and must provide a real, independent secret at runtime. This value
  // is deliberately not a deployment secret and cannot restore real sessions.
  if (process.env.PIXOMOSAIC_BUILD_PHASE === '1') {
    return 'build-phase-placeholder-not-a-runtime-secret-20260822'
  }

  {
    throw new Error('BETTER_AUTH_SECRET 必须单独设置为至少 32 个字符的高熵随机值。')
  }
}

const patchAccountStatusField = (collection: CollectionConfig): CollectionConfig => ({
  ...collection,
  fields: collection.fields?.map((field) => {
    if (!('name' in field) || field.name !== 'accountStatus') {
      return field
    }

    return {
      name: 'accountStatus',
      type: 'select',
      defaultValue: 'pending_verification',
      options: accountStatuses.map((value) => ({ label: value, value })),
      required: true,
      // The plugin identifies generated schema fields through this marker.
      // Keep it when changing the field's Payload presentation type.
      custom: field.custom,
    } satisfies SelectField
  }),
})

const validateAdminInvitationExpiresAt = (value: unknown): true | string => {
  if (value === null || value === undefined || value === '') {
    return '邀请到期时间必填。'
  }

  const timestamp = value instanceof Date ? value.getTime() : typeof value === 'string' ? new Date(value).getTime() : Number.NaN
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    return '邀请到期时间必须是未来时间。'
  }

  return true
}

const patchAdminInvitationCollection = (collection: CollectionConfig): CollectionConfig => ({
  ...collection,
  fields: collection.fields?.map((field) => {
    if (!('name' in field) || field.name !== 'expiresAt' || field.type !== 'date') {
      return field
    }

    return {
      ...field,
      // The plugin marks this field read-only, so the default is the only
      // value shown by the official create form. It also keeps direct creates
      // on the same seven-day invitation policy.
      defaultValue: () => new Date(Date.now() + adminInvitationLifetimeMilliseconds).toISOString(),
      validate: validateAdminInvitationExpiresAt,
    } satisfies DateField
  }),
})

export { clearLocalMailOutbox, getLatestLocalEmailVerificationOtp, getLocalMailOutbox } from '@/auth/mail'

export const betterAuthOptions = {
  secret: getBetterAuthSecret(),
  baseURL: runtimeConfig.authBaseUrl,
  basePath: runtimeConfig.authBasePath,
  trustedOrigins: runtimeConfig.authTrustedOrigins,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    requireEmailVerification: true,
    autoSignIn: false,
    revokeSessionsOnPasswordReset: true,
    resetPasswordTokenExpiresIn: passwordResetExpiresInSeconds,
    sendResetPassword: async ({ user, url, token }) => {
      await sendAuthMail({
        kind: 'password-reset',
        email: user.email,
        token,
        url,
      })
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: false,
    autoSignInAfterVerification: false,
    // emailOTP overrides the default JWT email-verification sender below.
    // Keeping this value documents the same M1 expiry at the Better Auth layer.
    expiresIn: emailVerificationExpiresInSeconds,
  },
  account: {
    accountLinking: {
      disableImplicitLinking: true,
      allowDifferentEmails: false,
      requireLocalEmailVerified: true,
    },
    encryptOAuthTokens: true,
    storeStateStrategy: 'database',
  },
  verification: {
    storeIdentifier: 'hashed',
  },
  plugins: [
    // Better Auth's default email verification token is a signed JWT and is
    // therefore reusable until expiry. M1 instead uses the maintained OTP
    // plugin: its verification row is atomically consumed, the OTP is hashed
    // in the database, and a wrong code has a bounded retry budget.
    emailOTP({
      overrideDefaultEmailVerification: true,
      expiresIn: emailVerificationExpiresInSeconds,
      allowedAttempts: 3,
      storeOTP: 'hashed',
      // The plugin also contains passwordless-sign-in endpoints. M1 keeps
      // email/password as the sole sign-in method, and the route guard blocks
      // those endpoints as a second boundary.
      disableSignUp: true,
      sendVerificationOTP: async ({ email, otp, type }) => {
        if (type !== 'email-verification') {
          throw new Error(`M1 不支持 ${type} 类型的邮箱 OTP。`)
        }

        await sendAuthMail({
          kind: 'email-verification-otp',
          email,
          otp,
        })
      },
    }),
    ...(googleOAuthPlugin ? [googleOAuthPlugin] : []),
  ],
  rateLimit: {
    enabled: true,
    storage: 'database',
    customRules: {
      '/sign-up/email': { window: 60, max: 5 },
      '/sign-in/email': { window: 60, max: 10 },
      '/request-password-reset': { window: 60, max: 5 },
      // Google redirect initiation is inexpensive but still needs a small
      // anti-loop boundary. Keep it separate from the email password bucket.
      '/sign-in/social': { window: 10 * 60, max: 10 },
      '/link-social': { window: 10 * 60, max: 10 },
    },
  },
  advanced: {
    useSecureCookies: runtimeConfig.cookieSecure,
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: 'lax',
      secure: runtimeConfig.cookieSecure,
      ...(runtimeConfig.cookieDomain ? { domain: runtimeConfig.cookieDomain } : {}),
    },
  },
  user: {
    additionalFields: {
      // These fields belong to the same source of truth as the Better Auth user.
      // They are not browser-editable through the generic auth handler.
      accountStatus: {
        type: 'string',
        defaultValue: 'pending_verification',
        input: false,
      },
      termsVersion: {
        type: 'string',
        required: false,
        input: false,
        returned: false,
      },
      termsAcceptedAt: {
        type: 'date',
        required: false,
        input: false,
        returned: false,
      },
      loginFailureCount: {
        type: 'number',
        defaultValue: 0,
        input: false,
        returned: false,
      },
      loginLockedUntil: {
        type: 'date',
        required: false,
        input: false,
        returned: false,
      },
      // Inventory thresholds persist with the account and are only exposed
      // through the authenticated inventory API.
      inventoryOutOfStockThreshold: {
        type: 'number',
        defaultValue: 50,
        input: false,
        returned: false,
      },
      inventoryWarningThreshold: {
        type: 'number',
        defaultValue: 100,
        input: false,
        returned: false,
      },
    },
    validateUserInfo: ({ user, source }) => {
      if (source.action !== 'create-user') {
        return
      }

      if (source.method === 'oauth' && source.oauth?.providerId === 'google' && user.emailVerified !== true) {
        return {
          error: 'GOOGLE_EMAIL_NOT_VERIFIED',
          errorDescription: 'Google 邮箱必须完成验证后才能创建账号。',
        }
      }

      if (!isRegistrationEmailAllowed(user.email)) {
        return {
          error: 'REGISTRATION_NOT_ALLOWED',
          errorDescription: '当前环境仅允许受邀邮箱注册。',
        }
      }
    },
  },
  databaseHooks: {
    user: {
      create: {
        // A Google account is allowed to become active only when the verified
        // OIDC provider reports email_verified=true. Email/password accounts
        // still start pending and can only be activated by the one-time OTP.
        before: async (user) => {
          if (user.emailVerified !== true) {
            return
          }

          return {
            data: {
              ...user,
              accountStatus: 'active',
            },
          }
        },
      },
      update: {
        // Email OTP verification updates both fields in one user write. This
        // avoids a window where emailVerified is true but cloud access remains
        // pending_verification.
        before: async (user) => {
          if (user.emailVerified !== true) {
            return
          }

          return {
            data: {
              ...user,
              accountStatus: 'active',
            },
          }
        },
      },
    },
  },
} satisfies NonNullable<PayloadAuthOptions['betterAuthOptions']>

export const betterAuthPluginOptions = {
  users: {
    slug: 'users',
    defaultRole: 'user',
    defaultAdminRole: 'admin',
    roles: ['user', 'staff', 'admin'],
    adminRoles: ['admin'],
    allowedFields: ['name'],
    collectionOverrides: ({ collection }) => patchAccountStatusField(collection),
  },
  accounts: {
    hidden: true,
    collectionOverrides: ({ collection }) => restrictAuthInternalCollection(collection),
  },
  adminInvitations: {
    collectionOverrides: ({ collection }) => patchAdminInvitationCollection(collection),
  },
  sessions: {
    hidden: true,
    collectionOverrides: ({ collection }) => restrictAuthInternalCollection(collection),
  },
  verifications: {
    hidden: true,
    collectionOverrides: ({ collection }) => restrictAuthInternalCollection(collection),
  },
  betterAuthOptions,
} satisfies PayloadAuthOptions
