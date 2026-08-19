import type { CollectionConfig } from 'payload'

export const userRoles = ['user', 'staff', 'admin'] as const
export const accountStatuses = ['pending_verification', 'active', 'suspended'] as const
export const authProviders = ['local', 'google'] as const

const isAdmin = ({ req }: { req: { user?: { role?: string } | null } }) =>
  req.user?.role === 'admin'

export const Users: CollectionConfig = {
  slug: 'users',
  admin: {
    useAsTitle: 'email',
  },
  access: {
    // The raw Payload Users REST surface is an internal management surface.
    // PixoMosaic users will use the versioned /api/v1 contract instead.
    admin: isAdmin,
    create: () => false,
    read: isAdmin,
    update: isAdmin,
    delete: isAdmin,
    unlock: isAdmin,
  },
  auth: {
    cookies: {
      domain: process.env.COOKIE_DOMAIN || undefined,
      sameSite: 'Lax',
      secure:
        process.env.COOKIE_SECURE === 'true' ||
        process.env.APP_ENV === 'team-test' ||
        process.env.NODE_ENV === 'production',
    },
    lockTime: 15 * 60 * 1000,
    maxLoginAttempts: 5,
    tokenExpiration: 2 * 60 * 60,
    verify: true,
  },
  fields: [
    {
      name: 'role',
      type: 'select',
      defaultValue: 'user',
      options: userRoles.map((value) => ({ label: value, value })),
      required: true,
    },
    {
      name: 'accountStatus',
      type: 'select',
      defaultValue: 'pending_verification',
      options: accountStatuses.map((value) => ({ label: value, value })),
      required: true,
    },
    {
      name: 'authProvider',
      type: 'select',
      defaultValue: 'local',
      options: authProviders.map((value) => ({ label: value, value })),
      required: true,
    },
    {
      name: 'googleSubject',
      type: 'text',
      unique: true,
      hidden: true,
    },
    {
      name: 'termsVersion',
      type: 'text',
      hidden: true,
    },
    {
      name: 'termsAcceptedAt',
      type: 'date',
      hidden: true,
    },
  ],
}
