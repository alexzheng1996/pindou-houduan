// 文件开头说明：官方内容后台使用与私密业务相同的权威 Better Auth 会话读取，
// 但只放行 Staff/Admin。它不接受请求体角色，也不授予用户、会话或私密作品读取权。
import { createLocalReq, type PayloadRequest, type TypedUser } from 'payload'

import { hasRole } from '@/collections/Users'
import {
  requireActiveSession,
  SessionRequirementError,
  type ActiveSessionContext,
} from '@/auth/require-session'

type ContentOperator = TypedUser & {
  id: number
  role?: string | string[] | null
}

export class ContentOperatorRequirementError extends Error {
  readonly code: 'CONTENT_OPERATOR_REQUIRED'
  readonly status = 403

  constructor() {
    super('当前账号没有内容后台权限。')
    this.code = 'CONTENT_OPERATOR_REQUIRED'
  }
}

export type ContentSessionContext = Omit<ActiveSessionContext, 'req' | 'user'> & {
  req: PayloadRequest
  user: ContentOperator
}

export const requireContentOperatorSession = async (
  request: Request,
  requestId: string,
): Promise<ContentSessionContext> => {
  const session = await requireActiveSession(request, requestId)
  const user = session.user as ContentOperator

  if (!hasRole(user, 'staff') && !hasRole(user, 'admin')) {
    throw new ContentOperatorRequirementError()
  }

  const req = await createLocalReq(
    {
      context: { requestId, contentService: true },
      req: { headers: request.headers },
      user,
    },
    session.payload,
  )

  return { ...session, req, user }
}

export { SessionRequirementError }
