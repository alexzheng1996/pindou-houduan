// 文件开头说明：社区治理后台沿用权威 Better Auth 会话，但只放行 active 的
// Staff/Admin。该上下文仅开放受控社区治理服务，不授予私密作品或认证资料读取权。
import { createLocalReq, type PayloadRequest, type TypedUser } from 'payload'

import { hasRole } from '@/collections/Users'
import {
  requireActiveSession,
  SessionRequirementError,
  type ActiveSessionContext,
} from '@/auth/require-session'

type CommunityOperator = TypedUser & {
  id: number
  role?: string | string[] | null
}

export class CommunityOperatorRequirementError extends Error {
  readonly code: 'COMMUNITY_MODERATION_FORBIDDEN'
  readonly status = 403

  constructor() {
    super('当前账号没有社区治理后台权限。')
    this.code = 'COMMUNITY_MODERATION_FORBIDDEN'
  }
}

export type CommunityOperatorSessionContext = Omit<ActiveSessionContext, 'req' | 'user'> & {
  req: PayloadRequest
  user: CommunityOperator
}

export const requireCommunityOperatorSession = async (
  request: Request,
  requestId: string,
): Promise<CommunityOperatorSessionContext> => {
  const session = await requireActiveSession(request, requestId)
  const user = session.user as CommunityOperator

  if (!hasRole(user, 'staff') && !hasRole(user, 'admin')) {
    throw new CommunityOperatorRequirementError()
  }

  const req = await createLocalReq(
    {
      context: { requestId, communityModerationService: true },
      req: { headers: request.headers },
      user,
    },
    session.payload,
  )

  return { ...session, req, user }
}

export { SessionRequirementError }
