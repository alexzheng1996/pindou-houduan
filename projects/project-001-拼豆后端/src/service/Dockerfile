# M0 container baseline: standalone Next output, Node 24 and no application data.
# Database data remains in PostgreSQL; user files will use private object storage in M1.

FROM node:24.19.0-alpine AS base

# Install dependencies only when needed
FROM base AS deps
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Install dependencies based on the preferred package manager
COPY package.json yarn.lock* package-lock.json* pnpm-lock.yaml* ./
RUN \
  if [ -f yarn.lock ]; then yarn --frozen-lockfile; \
  elif [ -f package-lock.json ]; then npm ci; \
  elif [ -f pnpm-lock.yaml ]; then corepack enable pnpm && pnpm i --frozen-lockfile; \
  else echo "Lockfile not found." && exit 1; \
  fi


# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
# Next collects route configuration during the image build and therefore
# evaluates Better Auth once. This non-secret marker is limited to the builder
# stage; the runner must receive a real secret from its deployment environment.
ENV PIXOMOSAIC_BUILD_PHASE=1

RUN \
  if [ -f yarn.lock ]; then yarn run build; \
  elif [ -f package-lock.json ]; then npm run build; \
  elif [ -f pnpm-lock.yaml ]; then corepack enable pnpm && pnpm run build; \
  else echo "Lockfile not found." && exit 1; \
  fi

# Production image, copy only the Next standalone output and static assets.
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Railway 必须以 APP_ENV=team-test 覆盖此无效默认值；防止漏配时把部署误当本机 local。
ENV APP_ENV=deployment-app-env-required

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public

# Set the correct permission for prerender cache
RUN mkdir .next
RUN chown nextjs:nodejs .next

# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3002

# 3002 是本机 Docker 默认值。Railway 会注入实际 PORT，不能在代码或健康检查中写死。
ENV PORT=3002
ENV HOSTNAME=0.0.0.0

# Verify application and database readiness without exposing configuration details.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# server.js is created by next build from the standalone output.
# Do this check before Next starts so a Railway deployment cannot silently fall
# back to local when APP_ENV was omitted. Local Docker verification must pass
# APP_ENV=local explicitly; Railway must pass APP_ENV=team-test explicitly.
# https://nextjs.org/docs/pages/api-reference/next-config-js/output
CMD ["sh", "-c", "case \"$APP_ENV\" in local|team-test) exec node server.js ;; *) echo 'APP_ENV must be local or team-test.' >&2; exit 64 ;; esac"]
