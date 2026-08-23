// 文件开头说明：仅供 Vitest 使用的 loopback OIDC 模拟器。它模拟授权码 + PKCE
// 回调和签名 ID Token，用于验证 M1 的 Google 登录安全门禁；不会连接 Google、
// 不读取真实凭据，也不会在正常开发或部署进程中启动。
import { createHash, createSign, generateKeyPairSync, randomUUID } from 'crypto'
import type { Server } from 'http'
import { createServer } from 'http'

const host = '127.0.0.1'
const port = 55441
const issuer = `http://${host}:${port}`
const clientId = 'pixomosaic-m1-local-google-mock-client'
const codeLifetimeMilliseconds = 5 * 60_000

type AuthorizationCode = {
  codeChallenge: string
  email: string
  emailVerified: boolean
  invalidClaim?: 'audience' | 'issuer' | 'nonce'
  nonce?: string
  subject: string
  used: boolean
  expiresAt: number
}

const base64Url = (value: Buffer): string => value.toString('base64url')

const jsonResponse = (response: import('http').ServerResponse, body: unknown, status = 200): void => {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

const getEmail = (candidate: string | null): string => {
  const value = candidate?.trim().toLowerCase()

  return value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
    ? value
    : 'mock-google-user@pixomosaic.local'
}

const getCodeChallenge = (codeVerifier: string): string =>
  createHash('sha256').update(codeVerifier).digest('base64url')

const readBody = async (request: import('http').IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  return Buffer.concat(chunks).toString('utf8')
}

export default async function setupMockGoogleOidc(): Promise<() => Promise<void>> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const publicJwk = publicKey.export({ format: 'jwk' })
  const authorizationCodes = new Map<string, AuthorizationCode>()

  const signIdToken = (authorization: AuthorizationCode): string => {
    const header = base64Url(Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'm1-local-google-mock', typ: 'JWT' })))
    const now = Math.floor(Date.now() / 1000)
    const payload = base64Url(
      Buffer.from(
        JSON.stringify({
          iss: authorization.invalidClaim === 'issuer' ? `${issuer}/unexpected` : issuer,
          aud: authorization.invalidClaim === 'audience' ? 'unexpected-client' : clientId,
          sub: authorization.subject,
          email: authorization.email,
          email_verified: authorization.emailVerified,
          name: 'PixoMosaic Local Google Mock',
          picture: 'https://example.invalid/mock-avatar.png',
          ...(authorization.nonce
            ? { nonce: authorization.invalidClaim === 'nonce' ? 'unexpected-nonce' : authorization.nonce }
            : {}),
          iat: now,
          exp: now + 5 * 60,
        }),
      ),
    )
    const signingInput = `${header}.${payload}`
    const signer = createSign('RSA-SHA256')
    signer.update(signingInput)
    signer.end()

    return `${signingInput}.${base64Url(signer.sign(privateKey))}`
  }

  const handler = async (
    request: import('http').IncomingMessage,
    response: import('http').ServerResponse,
  ): Promise<void> => {
    const url = new URL(request.url ?? '/', issuer)

    if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      jsonResponse(response, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        id_token_signing_alg_values_supported: ['RS256'],
      })
      return
    }

    if (request.method === 'GET' && url.pathname === '/jwks') {
      jsonResponse(response, {
        keys: [{ ...publicJwk, alg: 'RS256', kid: 'm1-local-google-mock', use: 'sig' }],
      })
      return
    }

    if (request.method === 'GET' && url.pathname === '/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri')
      const state = url.searchParams.get('state')
      const requestedClientId = url.searchParams.get('client_id')
      const codeChallenge = url.searchParams.get('code_challenge')

      if (!redirectUri || !state || requestedClientId !== clientId || !codeChallenge) {
        jsonResponse(response, { error: 'invalid_authorization_request' }, 400)
        return
      }

      const code = randomUUID()
      const email = getEmail(url.searchParams.get('login_hint'))
      const invalidClaim = url.searchParams.get('mock_invalid_claim')
      authorizationCodes.set(code, {
        codeChallenge,
        email,
        emailVerified: url.searchParams.get('mock_email_verified') !== 'false',
        invalidClaim:
          invalidClaim === 'issuer' || invalidClaim === 'audience' || invalidClaim === 'nonce'
            ? invalidClaim
            : undefined,
        nonce: url.searchParams.get('nonce') ?? undefined,
        subject: `mock-google-${createHash('sha256').update(email).digest('hex').slice(0, 32)}`,
        used: false,
        expiresAt: Date.now() + codeLifetimeMilliseconds,
      })
      const callback = new URL(redirectUri)
      callback.searchParams.set('code', code)
      callback.searchParams.set('state', state)
      response.writeHead(302, { location: callback.toString(), 'cache-control': 'no-store' })
      response.end()
      return
    }

    if (request.method === 'POST' && url.pathname === '/token') {
      const body = new URLSearchParams(await readBody(request))
      const code = body.get('code')
      const codeVerifier = body.get('code_verifier')
      const authorization = code ? authorizationCodes.get(code) : undefined

      if (
        !authorization ||
        authorization.used ||
        authorization.expiresAt <= Date.now() ||
        body.get('grant_type') !== 'authorization_code' ||
        body.get('client_id') !== clientId ||
        !codeVerifier ||
        getCodeChallenge(codeVerifier) !== authorization.codeChallenge
      ) {
        jsonResponse(response, { error: 'invalid_grant' }, 400)
        return
      }

      authorization.used = true
      jsonResponse(response, {
        access_token: `mock-access-${randomUUID()}`,
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'openid profile email',
        id_token: signIdToken(authorization),
      })
      return
    }

    jsonResponse(response, { error: 'not_found' }, 404)
  }

  const server: Server = createServer((request, response) => {
    void handler(request, response).catch(() => {
      if (!response.headersSent) {
        jsonResponse(response, { error: 'mock_internal_error' }, 500)
      } else {
        response.destroy()
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  return async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}
