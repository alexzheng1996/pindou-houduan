import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  // payload-auth 3.0.0 currently publishes ESM files with extensionless
  // relative imports. Let Vite transform it for tests instead of delegating
  // the package to Node's strict native ESM resolver.
  ssr: {
    noExternal: ['payload-auth'],
  },
  test: {
    environment: 'node',
    // The integration suites share one local PostgreSQL database and its
    // database-backed Better Auth rate limiter. Parallel files can clear or
    // consume the same counter and create order-dependent false failures.
    fileParallelism: false,
    // The mock is loopback-only and exists only for the test process. It
    // lets the full authorization-code callback be verified without a real
    // Google OAuth client, external network call or saved credential.
    globalSetup: ['./tests/int/mock-google-oidc.global-setup.ts'],
    env: {
      GOOGLE_OAUTH_MODE: 'mock',
      GOOGLE_OAUTH_DISCOVERY_URL: 'http://127.0.0.1:55441/.well-known/openid-configuration',
    },
    setupFiles: ['./vitest.setup.ts'],
    include: ['tests/int/**/*.int.spec.ts'],
  },
})
