import type { CollectionConfig, PayloadRequest } from 'payload'
import { BETTER_AUTH_CONTEXT_KEY } from 'payload-auth/better-auth/adapter'

export const userRoles = ['user', 'staff', 'admin'] as const
export const accountStatuses = ['pending_verification', 'active', 'suspended'] as const

type UserRole = (typeof userRoles)[number]

type BetterAuthRequest = PayloadRequest & {
  context?: Record<string, unknown>
  user?: { role?: UserRole | UserRole[] | string | null } | null
}

const hasRole = (user: BetterAuthRequest['user'], role: UserRole): boolean => {
  if (Array.isArray(user?.role)) {
    return user.role.includes(role)
  }

  return typeof user?.role === 'string' && user.role === role
}

const isAdmin = ({ req }: { req: BetterAuthRequest }) => hasRole(req.user, 'admin')

const isBetterAuthInternalRequest = (req: BetterAuthRequest): boolean =>
  Boolean(req.context?.[BETTER_AUTH_CONTEXT_KEY])

export const allowBetterAuthOrAdmin = ({ req }: { req: BetterAuthRequest }) =>
  isBetterAuthInternalRequest(req) || isAdmin({ req })

export const Users: CollectionConfig = {
  slug: 'users',
  admin: {
    useAsTitle: 'email',
  },
  access: {
    // The raw Payload Users REST surface is an internal management surface.
    // Better Auth's Payload adapter carries its own trusted context marker;
    // PixoMosaic users will use the versioned /api/v1 contract instead.
    admin: isAdmin,
    create: allowBetterAuthOrAdmin,
    read: allowBetterAuthOrAdmin,
    update: allowBetterAuthOrAdmin,
    delete: isAdmin,
    unlock: isAdmin,
  },
  // Fields are declared in betterAuthOptions.user.additionalFields, so the
  // plugin, runtime schema and database migration share one user definition.
  fields: [],
}
