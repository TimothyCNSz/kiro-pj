import { describe, it, expect, beforeEach } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'

import {
  createAuthMiddleware,
  adminGuard,
  type JwtVerifier,
  type AuthenticatedUser,
} from './auth'
import { errorHandler, notFoundHandler } from './error-handler'
import { ErrorCode, ERROR_DEFINITIONS } from '../lib/errors'
import { Role } from '../lib/domain'
import type { AuthTokenPayload } from '../services/auth-service'
import type { SessionManager, SessionRecord, CreatedSession } from '../services/session-service'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** 校验器替身：按 token 值查表返回载荷，未知返回 null。 */
class FakeVerifier implements JwtVerifier {
  constructor(private readonly table: Record<string, AuthTokenPayload>) {}
  verify(token: string): AuthTokenPayload | null {
    return this.table[token] ?? null
  }
}

/** 会话管理器替身：记录 validateAndTouch 调用，按 sid 决定有效性。 */
class FakeSessionManager implements SessionManager {
  readonly touched: string[] = []
  constructor(private readonly validSids: Set<string>) {}

  async validateAndTouch(sessionId: string): Promise<SessionRecord | null> {
    this.touched.push(sessionId)
    if (!this.validSids.has(sessionId)) return null
    return {
      id: sessionId,
      userId: 'user-1',
      lastActiveAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
    }
  }
  // 以下方法本套测试不直接使用，提供最小实现以满足接口。
  async create(): Promise<CreatedSession> {
    return { sessionId: 'session-x', expiresAt: new Date() }
  }
  async revoke(): Promise<void> {}
  async refresh(): Promise<SessionRecord | null> {
    return null
  }
  async touch(): Promise<SessionRecord | null> {
    return null
  }
}

const PAYLOAD_EMPLOYEE: AuthTokenPayload = { sub: 'user-1', sid: 'sid-ok', role: Role.Employee }
const PAYLOAD_ADMIN: AuthTokenPayload = { sub: 'admin-1', sid: 'sid-admin', role: Role.Admin }

function buildApp(sessionManager: SessionManager): Express {
  const verifier = new FakeVerifier({
    'tok-employee': PAYLOAD_EMPLOYEE,
    'tok-admin': PAYLOAD_ADMIN,
  })
  const auth = createAuthMiddleware({ verifier, sessionManager })

  const app = express()
  app.use(express.json())

  // 受保护路由：回显附加的 req.user，验证认证主体正确传递。
  app.get('/protected', auth, (req, res) => {
    res.json({ ok: true, user: req.user })
  })
  // 管理员路由：认证 + adminGuard。
  app.get('/admin-only', auth, adminGuard, (_req, res) => {
    res.json({ ok: true })
  })
  // 仅 adminGuard（无认证）：验证缺少 req.user 时回退 401。
  app.get('/guard-only', adminGuard, (_req, res) => {
    res.json({ ok: true })
  })

  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}

const unauthCode = ERROR_DEFINITIONS[ErrorCode.Unauthenticated].appCode
const forbiddenCode = ERROR_DEFINITIONS[ErrorCode.Forbidden].appCode

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createAuthMiddleware', () => {
  let sessions: FakeSessionManager
  let app: Express

  beforeEach(() => {
    sessions = new FakeSessionManager(new Set(['sid-ok', 'sid-admin']))
    app = buildApp(sessions)
  })

  it('rejects requests with no Authorization header as 401 (需求 1.15, 20.1)', async () => {
    const res = await request(app).get('/protected')
    expect(res.status).toBe(401)
    expect(res.body.code).toBe(unauthCode)
  })

  it('rejects a malformed Authorization header (no Bearer scheme) as 401', async () => {
    const res = await request(app).get('/protected').set('Authorization', 'tok-employee')
    expect(res.status).toBe(401)
    expect(res.body.code).toBe(unauthCode)
  })

  it('rejects an unverifiable token as 401', async () => {
    const res = await request(app).get('/protected').set('Authorization', 'Bearer nope')
    expect(res.status).toBe(401)
    expect(res.body.code).toBe(unauthCode)
  })

  it('rejects a valid token whose session is invalid/expired as 401 (需求 2.4, 20.3)', async () => {
    const expiredSessions = new FakeSessionManager(new Set()) // no valid sids
    const expiredApp = buildApp(expiredSessions)
    const res = await request(expiredApp).get('/protected').set('Authorization', 'Bearer tok-employee')
    expect(res.status).toBe(401)
    expect(res.body.code).toBe(unauthCode)
    // 会话空闲校验确实被调用。
    expect(expiredSessions.touched).toContain('sid-ok')
  })

  it('accepts a valid token + valid session, attaches req.user and touches the session (需求 2.2)', async () => {
    const res = await request(app).get('/protected').set('Authorization', 'Bearer tok-employee')
    expect(res.status).toBe(200)
    expect(res.body.user).toEqual<AuthenticatedUser>({
      userId: 'user-1',
      role: Role.Employee,
      sessionId: 'sid-ok',
    })
    expect(sessions.touched).toEqual(['sid-ok'])
  })
})

describe('adminGuard', () => {
  let sessions: FakeSessionManager
  let app: Express

  beforeEach(() => {
    sessions = new FakeSessionManager(new Set(['sid-ok', 'sid-admin']))
    app = buildApp(sessions)
  })

  it('allows an admin through (需求 3.2)', async () => {
    const res = await request(app).get('/admin-only').set('Authorization', 'Bearer tok-admin')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('forbids an employee with 403 (需求 3.3, 3.4, 20.4)', async () => {
    const res = await request(app).get('/admin-only').set('Authorization', 'Bearer tok-employee')
    expect(res.status).toBe(403)
    expect(res.body.code).toBe(forbiddenCode)
  })

  it('falls back to 401 when no authenticated user is present', async () => {
    const res = await request(app).get('/guard-only')
    expect(res.status).toBe(401)
    expect(res.body.code).toBe(unauthCode)
  })
})
