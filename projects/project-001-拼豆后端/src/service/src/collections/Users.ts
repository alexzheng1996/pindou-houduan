import type { CollectionConfig, PayloadRequest } from 'payload'
import { BETTER_AUTH_CONTEXT_KEY } from 'payload-auth/better-auth/adapter'

export const userRoles = ['user', 'staff', 'admin'] as const
export const accountStatuses = ['pending_verification', 'active', 'suspended'] as const

type BetterAuthRequest = PayloadRequest & {
  context?: Record<string, unknown>
  user?: { role?: string | string[] | null } | null
}

export const hasRole = (user: BetterAuthRequest['user'], role: (typeof userRoles)[number]): boolean => {
  const userRole: unknown = user?.role

  if (Array.isArray(userRole)) {
    return userRole.includes(role)
  }

  if (typeof userRole === 'string') {
    return userRole.split(',').map((item: string) => item.trim()).includes(role)
  }

  return false
}

export const isAdmin = ({ req }: { req: BetterAuthRequest }) => hasRole(req.user, 'admin')

// Payload has one global Admin entry gate. Staff may enter it only because M2.1
// exposes a tightly scoped content collection; individual collection access
// remains the authority for what they can actually view or edit.
export const isStaffOrAdmin = ({ req }: { req: BetterAuthRequest }) =>
  hasRole(req.user, 'staff') || hasRole(req.user, 'admin')

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
    admin: isStaffOrAdmin,
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
