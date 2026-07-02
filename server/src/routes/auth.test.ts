import { describe, it, expect, beforeEach } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'

import {
  createAuthRouter,
  type AccountGateway,
  REGISTER_OK_MESSAGE,
  REGISTER_EMAIL_FAILED_MESSAGE,
  VERIFY_OK_MESSAGE,
  RESEND_OK_MESSAGE,
  LOGIN_OK_MESSAGE,
} from './auth'
import { createAuthMiddleware, type JwtVerifier } from '../middleware/auth'
import { errorHandler, notFoundHandler } from '../middleware/error-handler'
import { HttpError } from '../middleware/http-error'
import { SUCCESS_CODE } from '../lib/api'
import { AccountStatus, Role } from '../lib/domain'
import { ErrorCode, ERROR_DEFINITIONS } from '../lib/errors'
import type { AuthTokenPayload } from '../services/auth-service'
import type { ValidationResult } from '../services/email-verification-service'
import type { SessionManager, SessionRecord, CreatedSession } from '../services/session-service'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeAuthService {
  registerResult: { userId: string; status: AccountStatus; emailSendFailed: boolean } = {
    userId: 'u1',
    status: AccountStatus.PendingVerification,
    emailSendFailed: false,
  }
  loginResult: { token: string; role: Role } = { token: 'jwt-token', role: Role.Employee }
  loginError: unknown = null
  readonly loggedOut: string[] = []

  async register(email: string, _password: string) {
    if (email === 'send-fail@company.com') {
      return { ...this.registerResult, emailSendFailed: true }
    }
    return this.registerResult
  }
  async login(_email: string, _password: string) {
    if (this.loginError) throw this.loginError
    return this.loginResult
  }
  async logout(sessionId: string) {
    this.loggedOut.push(sessionId)
  }
}

class FakeEmailVerificationService {
  result: ValidationResult = { userId: 'u1' }
  readonly invalidated: string[] = []
  readonly issued: string[] = []

  async validate(_token: string, _now: Date): Promise<ValidationResult> {
    return this.result
  }
  async invalidateExisting(userId: string) {
    this.invalidated.push(userId)
  }
  async issue(userId: string) {
    this.issued.push(userId)
    return { token: 't', expiresAt: new Date() }
  }
}

class FakeAccountGateway implements AccountGateway {
  readonly activated: string[] = []
  pendingUserId: string | null = 'u1'

  async activate(userId: string) {
    this.activated.push(userId)
  }
  async findPendingUserIdByEmail(_email: string) {
    return this.pendingUserId
  }
}

class FakeVerifier implements JwtVerifier {
  constructor(private readonly table: Record<string, AuthTokenPayload>) {}
  verify(token: string) {
    return this.table[token] ?? null
  }
}

class FakeSessionManager implements SessionManager {
  constructor(private readonly validSids: Set<string>) {}
  async validateAndTouch(sessionId: string): Promise<SessionRecord | null> {
    if (!this.validSids.has(sessionId)) return null
    return {
      id: sessionId,
      userId: 'user-1',
      lastActiveAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
    }
  }
  async create(): Promise<CreatedSession> {
    return { sessionId: 'sx', expiresAt: new Date() }
  }
  async revoke(): Promise<void> {}
  async refresh(): Promise<SessionRecord | null> {
    return null
  }
  async touch(): Promise<SessionRecord | null> {
    return null
  }
}

const PAYLOAD: AuthTokenPayload = { sub: 'user-1', sid: 'sid-ok', role: Role.Employee }

interface Harness {
  app: Express
  authService: FakeAuthService
  emailService: FakeEmailVerificationService
  accountGateway: FakeAccountGateway
}

function buildHarness(): Harness {
  const authService = new FakeAuthService()
  const emailService = new FakeEmailVerificationService()
  const accountGateway = new FakeAccountGateway()
  const authMiddleware = createAuthMiddleware({
    verifier: new FakeVerifier({ 'tok-ok': PAYLOAD }),
    sessionManager: new FakeSessionManager(new Set(['sid-ok'])),
  })

  const router = createAuthRouter({
    authService,
    emailVerificationService: emailService,
    accountGateway,
    authMiddleware,
  })

  const app = express()
  app.use(express.json())
  app.use('/auth', router)
  app.use(notFoundHandler)
  app.use(errorHandler)

  return { app, authService, emailService, accountGateway }
}

const codeOf = (c: ErrorCode) => ERROR_DEFINITIONS[c].appCode

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /auth/register', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })

  it('returns 201 + success envelope on normal registration (需求 1.4)', async () => {
    const res = await request(h.app)
      .post('/auth/register')
      .send({ email: 'new@company.com', password: 'Password1' })
    expect(res.status).toBe(201)
    expect(res.body.code).toBe(SUCCESS_CODE)
    expect(res.body.message).toBe(REGISTER_OK_MESSAGE)
    expect(res.body.data).toEqual({ status: AccountStatus.PendingVerification, emailSendFailed: false })
  })

  it('returns 202 with a distinct message when the verification email failed to send (需求 1.4)', async () => {
    const res = await request(h.app)
      .post('/auth/register')
      .send({ email: 'send-fail@company.com', password: 'Password1' })
    expect(res.status).toBe(202)
    expect(res.body.message).toBe(REGISTER_EMAIL_FAILED_MESSAGE)
    expect(res.body.data.emailSendFailed).toBe(true)
  })
})

describe('GET /auth/verify-email', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })

  it('activates the account and returns success on a valid token (需求 1.9)', async () => {
    h.emailService.result = { userId: 'u1' }
    const res = await request(h.app).get('/auth/verify-email').query({ token: 'good' })
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(SUCCESS_CODE)
    expect(res.body.message).toBe(VERIFY_OK_MESSAGE)
    expect(h.accountGateway.activated).toEqual(['u1'])
  })

  it('returns 410 VERIFICATION_EXPIRED for an expired token (需求 1.10)', async () => {
    h.emailService.result = { error: 'EXPIRED' }
    const res = await request(h.app).get('/auth/verify-email').query({ token: 'old' })
    expect(res.status).toBe(410)
    expect(res.body.code).toBe(codeOf(ErrorCode.VerificationExpired))
    expect(h.accountGateway.activated).toEqual([])
  })

  it('returns 400 VERIFICATION_INVALID for an invalid token', async () => {
    h.emailService.result = { error: 'INVALID' }
    const res = await request(h.app).get('/auth/verify-email').query({ token: 'bad' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe(codeOf(ErrorCode.VerificationInvalid))
  })

  it('returns 400 VERIFICATION_INVALID when the token is missing', async () => {
    const res = await request(h.app).get('/auth/verify-email')
    expect(res.status).toBe(400)
    expect(res.body.code).toBe(codeOf(ErrorCode.VerificationInvalid))
  })
})

describe('POST /auth/resend-verification', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })

  it('invalidates old tokens and issues a new one for a pending account (需求 1.11)', async () => {
    h.accountGateway.pendingUserId = 'u9'
    const res = await request(h.app)
      .post('/auth/resend-verification')
      .send({ email: 'pending@company.com' })
    expect(res.status).toBe(200)
    expect(res.body.message).toBe(RESEND_OK_MESSAGE)
    expect(h.emailService.invalidated).toEqual(['u9'])
    expect(h.emailService.issued).toEqual(['u9'])
  })

  it('returns the same envelope without issuing when no pending account matches (anti-enumeration)', async () => {
    h.accountGateway.pendingUserId = null
    const res = await request(h.app)
      .post('/auth/resend-verification')
      .send({ email: 'unknown@company.com' })
    expect(res.status).toBe(200)
    expect(res.body.message).toBe(RESEND_OK_MESSAGE)
    expect(h.emailService.issued).toEqual([])
  })
})

describe('POST /auth/login', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })

  it('returns token + role on success (需求 1.12, 2.1)', async () => {
    const res = await request(h.app)
      .post('/auth/login')
      .send({ email: 'active@company.com', password: 'Password1' })
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(SUCCESS_CODE)
    expect(res.body.message).toBe(LOGIN_OK_MESSAGE)
    expect(res.body.data).toEqual({ token: 'jwt-token', role: Role.Employee })
  })

  it('propagates credential errors as 401 (需求 1.14)', async () => {
    h.authService.loginError = new HttpError(ErrorCode.Unauthenticated, '邮箱或密码错误')
    const res = await request(h.app)
      .post('/auth/login')
      .send({ email: 'active@company.com', password: 'wrong' })
    expect(res.status).toBe(401)
    expect(res.body.code).toBe(codeOf(ErrorCode.Unauthenticated))
  })
})

describe('POST /auth/logout', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })

  it('requires authentication (需求 1.15)', async () => {
    const res = await request(h.app).post('/auth/logout')
    expect(res.status).toBe(401)
    expect(res.body.code).toBe(codeOf(ErrorCode.Unauthenticated))
    expect(h.authService.loggedOut).toEqual([])
  })

  it('terminates the current session for an authenticated user (需求 2.5)', async () => {
    const res = await request(h.app).post('/auth/logout').set('Authorization', 'Bearer tok-ok')
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(SUCCESS_CODE)
    expect(h.authService.loggedOut).toEqual(['sid-ok'])
  })
})

describe('GET /auth/me', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })

  it('requires authentication (需求 1.15, 20.1)', async () => {
    const res = await request(h.app).get('/auth/me')
    expect(res.status).toBe(401)
    expect(res.body.code).toBe(codeOf(ErrorCode.Unauthenticated))
  })

  it('returns the current user for an authenticated request (需求 2.2)', async () => {
    const res = await request(h.app).get('/auth/me').set('Authorization', 'Bearer tok-ok')
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(SUCCESS_CODE)
    expect(res.body.data).toEqual({ userId: 'user-1', role: Role.Employee })
  })
})
