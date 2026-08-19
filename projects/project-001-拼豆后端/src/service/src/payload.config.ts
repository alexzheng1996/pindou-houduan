import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import path from 'path'
import { buildConfig } from 'payload'
import { fileURLToPath } from 'url'
import sharp from 'sharp'

import { Users } from './collections/Users'
import { runtimeConfig } from './config/runtime'
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
  collections: [Users],
  cors: runtimeConfig.allowedOrigins,
  csrf: runtimeConfig.csrfOrigins,
  editor: lexicalEditor(),
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
    push: false,
  }),
  sharp,
  plugins: [],
  telemetry: false,
})
