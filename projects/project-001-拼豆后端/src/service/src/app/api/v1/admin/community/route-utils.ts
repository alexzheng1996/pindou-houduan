// 文件开头说明：社区治理路由共用统一的 CORS、会话错误投影和最小业务错误转换，
// 避免每个后台端点各自放宽鉴权或漏掉可信来源校验。
import { BusinessApiError } from '@/api/business-http'
import {
  CommunityOperatorRequirementError,
  SessionRequirementError,
} from '@/auth/require-community-operator-session'

export const moderationBusinessError = (error: unknown): BusinessApiError => {
  if (error instanceof BusinessApiError) return error
  if (error instanceof SessionRequirementError || error instanceof CommunityOperatorRequirementError) {
    return new BusinessApiError(error.code, error.message, error.status)
  }
  return new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
}
