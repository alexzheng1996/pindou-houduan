// 文件开头说明：M1 密码登录的账号状态与失败锁定门禁。认证真值仍由 Better Auth
// 管理；本模块只维护其 user 扩展字段，不记录密码、会话令牌或完整个人数据。
import type { Payload } from 'payload'

const maxConsecutiveFailures = 5
const lockDurationMilliseconds = 15 * 60 * 1000

type LoginGuardUser = {
  id: number
  accountStatus: 'pending_verification' | 'active' | 'suspended'
  loginLockedUntil?: string | null
}

type QueryablePool = {
  query: (
    query: string,
    parameters: readonly unknown[],
  ) => Promise<{ rows: Array<{ login_locked_until: Date | string | null }> }>
}

const getPool = (payload: Payload): QueryablePool => {
  const pool = (payload.db as unknown as { pool?: QueryablePool }).pool

  if (!pool) {
    throw new Error('M1 密码登录门禁需要 PostgreSQL 连接池。')
  }

  return pool
}

const normalizeEmail = (email: string): string => email.trim().toLowerCase()

const toTimestamp = (value: string | null | undefined): number =>
  value ? new Date(value).getTime() : Number.NaN

export const getLoginEmail = async (request: Request): Promise<string | null> => {
  try {
    const body = (await request.clone().json()) as { email?: unknown }

    return typeof body.email === 'string' ? normalizeEmail(body.email) : null
  } catch {
    return null
  }
}

export const getLoginGuardUser = async (
  payload: Payload,
  email: string,
): Promise<LoginGuardUser | null> => {
  const users = await payload.find({
    collection: 'users',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: {
      email: {
        equals: normalizeEmail(email),
      },
    },
  })

  const user = users.docs[0] as LoginGuardUser | undefined

  return user ?? null
}

export const getLoginBlockResponse = (user: LoginGuardUser): Response | null => {
  if (user.accountStatus === 'suspended') {
    return Response.json(
      { code: 'ACCOUNT_UNAVAILABLE', message: '当前账号暂不可登录，请联系支持人员。' },
      { status: 403 },
    )
  }

  const lockedUntil = toTimestamp(user.loginLockedUntil)
  if (Number.isFinite(lockedUntil) && lockedUntil > Date.now()) {
    return Response.json(
      { code: 'LOGIN_TEMPORARILY_LOCKED', message: '登录尝试次数过多，请稍后再试。' },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1000))),
        },
      },
    )
  }

  return null
}

export const clearLoginFailures = async (payload: Payload, userId: number): Promise<void> => {
  await getPool(payload).query(
    `UPDATE users
     SET login_failure_count = 0,
         login_locked_until = NULL
     WHERE id = $1`,
    [userId],
  )
}

export const recordFailedLogin = async (payload: Payload, userId: number): Promise<boolean> => {
  const result = await getPool(payload).query(
    `UPDATE users
     SET login_failure_count = CASE
           WHEN login_locked_until IS NOT NULL AND login_locked_until <= NOW() THEN 1
           ELSE login_failure_count + 1
         END,
         login_locked_until = CASE
           WHEN login_locked_until IS NOT NULL AND login_locked_until <= NOW() THEN NULL
           WHEN login_failure_count + 1 >= $2 THEN NOW() + ($3 * INTERVAL '1 millisecond')
           ELSE login_locked_until
         END
     WHERE id = $1
     RETURNING login_locked_until`,
    [userId, maxConsecutiveFailures, lockDurationMilliseconds],
  )

  return Boolean(result.rows[0]?.login_locked_until)
}

export const loginLockPolicy = {
  maxConsecutiveFailures,
  lockDurationMilliseconds,
} as const
