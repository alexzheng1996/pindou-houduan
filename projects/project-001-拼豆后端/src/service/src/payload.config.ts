import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import path from 'path'
import { buildConfig } from 'payload'
import { fileURLToPath } from 'url'
import { betterAuthPlugin } from 'payload-auth/better-auth/plugin'
import sharp from 'sharp'

import { authInternalCollections } from './auth/collections'
import { betterAuthPluginOptions } from './auth/config'
import { createPayloadEmailAdapter, registerPayloadMailSender } from './auth/mail'
import { Users } from './collections/Users'
import { ArticleMedia, Articles } from './collections/Content'
import { ApiIdempotencyRecords, WorkAssets, WorkDocuments, Works } from './collections/Works'
import { runtimeConfig } from './config/runtime'
import { preserveM1RelationshipDeleteActions } from './db/work-relationship-constraints'
import { migrations } from './migrations'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
  },
  // M0 intentionally has no upload collection: user files remain out of the
  // application disk until the M1 private S3/R2 storage boundary is verified.
  collections: [
    Users,
    ...authInternalCollections,
    Works,
    WorkDocuments,
    WorkAssets,
    ApiIdempotencyRecords,
    Articles,
    ArticleMedia,
  ],
  cors: runtimeConfig.allowedOrigins,
  csrf: runtimeConfig.csrfOrigins,
  editor: lexicalEditor(),
  email: createPayloadEmailAdapter(),
  graphQL: {
    // M0 has no public GraphQL contract. Keep its attack surface closed until a
    // later approved API decision explicitly needs it.
    disable: true,
  },
  secret: process.env.PAYLOAD_SECRET || '',
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  db: postgresAdapter({
    pool: {
      connectionString: process.env.DATABASE_URL || '',
    },
    // Schema changes are applied only through the reviewed migration history.
    // Do not re-enable Payload's development schema push: it marks databases
    // as divergent and makes later deployment migrations require confirmation.
    prodMigrations: migrations,
    // Payload 3.88 defaults all single relationships to SET NULL. M1 keeps
    // ownership/history relations RESTRICT and only allows clearing the current
    // document pointer; see the companion hook and reviewed migrations.
    beforeSchemaInit: [preserveM1RelationshipDeleteActions],
    push: false,
  }),
  sharp,
  onInit: (payload) => {
    registerPayloadMailSender(payload.sendEmail)
  },
  plugins: [betterAuthPlugin(betterAuthPluginOptions)],
  telemetry: false,
})
