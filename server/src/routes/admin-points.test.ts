import { describe, it, expect, beforeEach } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'

import {
  createAdminPointsRouter,
  type PointsAdjustService,
  ADJUST_OK_MESSAGE,
  BATCH_ADJUST_OK_MESSAGE,
} from './admin-points'
import { createAuthMiddleware, type JwtVerifier } from '../middleware/auth'
import { errorHandler, notFoundHandler } from '../middleware/error-handler'
import { SUCCESS_CODE } from '../lib/api'
import { Role } from '../lib/domain'
import { ErrorCode, ERROR_DEFINITIONS } from '../lib/errors'
import { HttpError } from '../middleware/http-error'
import type { BatchAdjustResult, PointsAccountView } from '../services/points-service'
import type { AuthTokenPayload } from '../services/auth-service'
import type { SessionManager, SessionRecord, CreatedSession } from '../services/session-service'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface AdjustCall {
  adminId: string
  userId: string
  delta: number
  note?: string
}

interface BatchCall {
  adminId: string
  userIds: string[]
  delta: number
  note?: string
}

class FakePointsService implements PointsAdjustService {
  adjustCalls: AdjustCall[] = []
  batchCalls: BatchCall[] = []
  adjustResult: PointsAccountView = { userId: 'u1', balance: 0 }
  batchResult: BatchAdjustResult = { succeeded: [], skipped: [] }
  /** 若设置则 adjust 抛出该错误（模拟余额不足）。 */
  adjustError: Error | null = null

  async adjust(adminId: string, userId: string, delta: number, note?: string) {
    this.adjustCalls.push({ adminId, userId, delta, note })
    if (this.adjustError) throw this.adjustError
    return this.adjustResult
  }

  async batchAdjust(adminId: string, userIds: string[], delta: number, note?: string) {
    this.batchCalls.push({ adminId, userIds, delta, note })
    return this.batchResult
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

const ADMIN_TOKEN = 'tok-admin'
const EMPLOYEE_TOKEN = 'tok-employee'

interface Harness {
  app: Express
  pointsService: FakePointsService
}

function buildHarness(): Harness {
  const pointsService = new FakePointsService()
  const authMiddleware = createAuthMiddleware({
    verifier: new FakeVerifier({
      [ADMIN_TOKEN]: { sub: 'admin-1', sid: 'sid-admin', role: Role.Admin },
      [EMPLOYEE_TOKEN]: { sub: 'emp-1', sid: 'sid-emp', role: Role.Employee },
    }),
    sessionManager: new FakeSessionManager(new Set(['sid-admin', 'sid-emp'])),
  })

  const router = createAdminPointsRouter({ pointsService, authMiddleware })

  const app = express()
  app.use(express.json())
  app.use('/admin/points', router)
  app.use(notFoundHandler)
  app.use(errorHandler)

  return { app, pointsService }
}

const codeOf = (c: ErrorCode) => ERROR_DEFINITIONS[c].appCode

// ---------------------------------------------------------------------------
// POST /admin/points/adjust
// ---------------------------------------------------------------------------

describe('POST /admin/points/adjust', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })

  it('rejects unauthenticated requests with 401 (需求 20.1, 20.3)', async () => {
    const res = await request(h.app).post('/admin/points/adjust').send({ userId: 'u1', delta: 10 })
    expect(res.status).toBe(401)
    expect(res.body.code).toBe(codeOf(ErrorCode.Unauthenticated))
    expect(h.pointsService.adjustCalls).toHaveLength(0)
  })

  it('rejects non-admin (employee) requests with 403 (需求 3.3, 20.4)', async () => {
    const res = await request(h.app)
      .post('/admin/points/adjust')
      .set('Authorization', `Bearer ${EMPLOYEE_TOKEN}`)
      .send({ userId: 'u1', delta: 10 })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe(codeOf(ErrorCode.Forbidden))
    expect(h.pointsService.adjustCalls).toHaveLength(0)
  })

  it('adjusts and forwards adminId/userId/delta/note to the service (需求 13.1, 13.5)', async () => {
    h.pointsService.adjustResult = { userId: 'u1', balance: 150 }
    const res = await request(h.app)
      .post('/admin/points/adjust')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ userId: 'u1', delta: 50, note: '季度奖励' })

    expect(res.status).toBe(200)
    expect(res.body.code).toBe(SUCCESS_CODE)
    expect(res.body.message).toBe(ADJUST_OK_MESSAGE)
    expect(res.body.data).toEqual({ userId: 'u1', balance: 150 })
    expect(h.pointsService.adjustCalls[0]).toEqual({
      adminId: 'admin-1',
      userId: 'u1',
      delta: 50,
      note: '季度奖励',
    })
  })

  it('propagates INSUFFICIENT_POINTS from the service as 409 (需求 13.3)', async () => {
    h.pointsService.adjustError = new HttpError(ErrorCode.InsufficientPoints, '余额不足')
    const res = await request(h.app)
      .post('/admin/points/adjust')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ userId: 'u1', delta: -999 })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe(codeOf(ErrorCode.InsufficientPoints))
  })

  it('rejects a missing userId with 422', async () => {
    const res = await request(h.app)
      .post('/admin/points/adjust')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ delta: 10 })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe(codeOf(ErrorCode.Validation))
    expect(h.pointsService.adjustCalls).toHaveLength(0)
  })

  it('rejects a non-integer delta with 422', async () => {
    const res = await request(h.app)
      .post('/admin/points/adjust')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ userId: 'u1', delta: 1.5 })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe(codeOf(ErrorCode.Validation))
    expect(h.pointsService.adjustCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// POST /admin/points/batch-adjust
// ---------------------------------------------------------------------------

describe('POST /admin/points/batch-adjust', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })

  it('rejects non-admin (employee) requests with 403 (需求 3.3, 20.4)', async () => {
    const res = await request(h.app)
      .post('/admin/points/batch-adjust')
      .set('Authorization', `Bearer ${EMPLOYEE_TOKEN}`)
      .send({ userIds: ['u1'], delta: 10 })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe(codeOf(ErrorCode.Forbidden))
    expect(h.pointsService.batchCalls).toHaveLength(0)
  })

  it('returns the partial-success partition and forwards params (需求 13.2, 13.4)', async () => {
    h.pointsService.batchResult = {
      succeeded: [{ userId: 'rich', newBalance: 50 }],
      skipped: [{ userId: 'poor', reason: 'INSUFFICIENT_BALANCE' }],
    }
    const res = await request(h.app)
      .post('/admin/points/batch-adjust')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ userIds: ['rich', 'poor'], delta: -50, note: '罚扣' })

    expect(res.status).toBe(200)
    expect(res.body.code).toBe(SUCCESS_CODE)
    expect(res.body.message).toBe(BATCH_ADJUST_OK_MESSAGE)
    expect(res.body.data).toEqual({
      succeeded: [{ userId: 'rich', newBalance: 50 }],
      skipped: [{ userId: 'poor', reason: 'INSUFFICIENT_BALANCE' }],
    })
    expect(h.pointsService.batchCalls[0]).toEqual({
      adminId: 'admin-1',
      userIds: ['rich', 'poor'],
      delta: -50,
      note: '罚扣',
    })
  })

  it('rejects an empty userIds array with 422', async () => {
    const res = await request(h.app)
      .post('/admin/points/batch-adjust')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ userIds: [], delta: 10 })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe(codeOf(ErrorCode.Validation))
    expect(h.pointsService.batchCalls).toHaveLength(0)
  })

  it('rejects a non-string userId entry with 422', async () => {
    const res = await request(h.app)
      .post('/admin/points/batch-adjust')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ userIds: ['u1', 123], delta: 10 })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe(codeOf(ErrorCode.Validation))
    expect(h.pointsService.batchCalls).toHaveLength(0)
  })
})
