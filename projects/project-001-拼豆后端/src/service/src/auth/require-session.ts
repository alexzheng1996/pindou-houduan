// 文件开头说明：业务 API 统一通过此模块把 Better Auth 的权威会话转换为 Payload
// 本地请求。它不解析浏览器 Cookie，也不接受前端传入的 userId；私密作品等敏感
// 操作始终重新查询数据库中的会话与账号状态。
import config from '@payload-config'
import { createLocalReq, type Payload, type PayloadRequest, type TypedUser } from 'payload'
import { getPayloadAuth } from 'payload-auth/better-auth/plugin'

type AccountStatus = 'pending_verification' | 'active' | 'suspended'

type BusinessUser = TypedUser & {
  id: number
  accountStatus: AccountStatus
  emailVerified: boolean
}

type BetterAuthSession = {
  session: { userId: number | string }
  user: { id: number | string }
}

export class SessionRequirementError extends Error {
  readonly code: 'AUTH_REQUIRED' | 'ACCOUNT_UNAVAILABLE'
  readonly status: 401 | 403

  constructor(code: SessionRequirementError['code']) {
    super(code === 'AUTH_REQUIRED' ? '请先登录后再继续。' : '当前账号不能访问私密资源。')
    this.code = code
    this.status = code === 'AUTH_REQUIRED' ? 401 : 403
  }
}

const toUserId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return value
  }

  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value)

    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
  }

  return null
}

const isBusinessUser = (value: unknown): value is BusinessUser => {
  if (!value || typeof value !== 'object') {
    return false
  }

  const user = value as Partial<BusinessUser>

  return (
    typeof user.id === 'number' &&
    typeof user.emailVerified === 'boolean' &&
    (user.accountStatus === 'pending_verification' ||
      user.accountStatus === 'active' ||
      user.accountStatus === 'suspended')
  )
}

export type ActiveSessionContext = {
  payload: Payload
  requestId: string
  req: PayloadRequest
  user: BusinessUser
}

export const requireActiveSession = async (
  request: Request,
  requestId: string,
): Promise<ActiveSessionContext> => {
  const payload = await getPayloadAuth(config)
  const session = (await payload.betterAuth.api.getSession({
    headers: request.headers,
    query: {
      // Reads directly from the durable session store. A revoked session or a
      // newly suspended account must not keep access through a cookie cache.
      disableCookieCache: true,
      disableRefresh: true,
    },
  })) as BetterAuthSession | null
  const userId = toUserId(session?.session.userId ?? session?.user.id)

  if (!userId) {
    throw new SessionRequirementError('AUTH_REQUIRED')
  }

  const user = await payload.findByID({
    collection: 'users',
    id: userId,
    depth: 0,
    overrideAccess: true,
  })

  if (!isBusinessUser(user) || !user.emailVerified || user.accountStatus !== 'active') {
    throw new SessionRequirementError('ACCOUNT_UNAVAILABLE')
  }

  const req = await createLocalReq(
    {
      context: { requestId, workService: true },
      req: {
        headers: request.headers,
      },
      user,
    },
    payload,
  )

  return { payload, requestId, req, user }
}
