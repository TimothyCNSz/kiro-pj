import { describe, it, expect, beforeEach } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'

import {
  createAdminLogsRouter,
  type LogQueryService,
  LIST_LOGS_OK_MESSAGE,
} from './admin-logs'
import { createAuthMiddleware, type JwtVerifier } from '../middleware/auth'
import { errorHandler, notFoundHandler } from '../middleware/error-handler'
import { SUCCESS_CODE, type PaginatedData, type PaginationParams } from '../lib/api'
import { Role } from '../lib/domain'
import { ErrorCode, ERROR_DEFINITIONS } from '../lib/errors'
import type { OperationLogView } from '../services/log-service'
import type { AuthTokenPayload } from '../services/auth-service'
import type { SessionManager, SessionRecord, CreatedSession } from '../services/session-service'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const emptyPage: PaginatedData<OperationLogView> = { list: [], total: 0, page: 1, pageSize: 20 }

class FakeLogService implements LogQueryService {
  readonly calls: PaginationParams[] = []
  result: PaginatedData<OperationLogView> = emptyPage
  error: unknown = null

  async listLogs(pagination: PaginationParams): Promise<PaginatedData<OperationLogView>> {
    this.calls.push(pagination)
    if (this.error) throw this.error
    return this.result
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
  logService: FakeLogService
}

function buildHarness(): Harness {
  const logService = new FakeLogService()
  const authMiddleware = createAuthMiddleware({
    verifier: new FakeVerifier({
      [ADMIN_TOKEN]: { sub: 'admin-1', sid: 'sid-admin', role: Role.Admin },
      [EMPLOYEE_TOKEN]: { sub: 'emp-1', sid: 'sid-emp', role: Role.Employee },
    }),
    sessionManager: new FakeSessionManager(new Set(['sid-admin', 'sid-emp'])),
  })

  const router = createAdminLogsRouter({ logService, authMiddleware })

  const app = express()
  app.use(express.json())
  app.use('/admin/logs', router)
  app.use(notFoundHandler)
  app.use(errorHandler)

  return { app, logService }
}

const codeOf = (c: ErrorCode) => ERROR_DEFINITIONS[c].appCode

const sampleLogs: OperationLogView[] = [
  {
    id: 'l1',
    actorId: 'admin-1',
    action: 'points_grant',
    targetType: 'user',
    targetId: 'u1',
    createdAt: new Date('2024-01-02T00:00:00Z'),
  },
  {
    id: 'l2',
    actorId: 'admin-1',
    action: 'product_create',
    targetType: 'product',
    targetId: 'p1',
    createdAt: new Date('2024-01-01T00:00:00Z'),
  },
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /admin/logs', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })

  it('rejects unauthenticated requests with 401 (需求 20.1, 20.3)', async () => {
    const res = await request(h.app).get('/admin/logs')
    expect(res.status).toBe(401)
    expect(res.body.code).toBe(codeOf(ErrorCode.Unauthenticated))
    expect(h.logService.calls).toHaveLength(0)
  })

  it('rejects non-admin (employee) requests with 403 (需求 3.3, 20.4)', async () => {
    const res = await request(h.app)
      .get('/admin/logs')
      .set('Authorization', `Bearer ${EMPLOYEE_TOKEN}`)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe(codeOf(ErrorCode.Forbidden))
    expect(h.logService.calls).toHaveLength(0)
  })

  it('returns paginated operation logs newest-first for an admin (需求 16.2)', async () => {
    h.logService.result = { list: sampleLogs, total: 2, page: 1, pageSize: 20 }

    const res = await request(h.app)
      .get('/admin/logs')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)

    expect(res.status).toBe(200)
    expect(res.body.code).toBe(SUCCESS_CODE)
    expect(res.body.message).toBe(LIST_LOGS_OK_MESSAGE)
    expect(res.body.data.list).toHaveLength(2)
    expect(res.body.data.list.map((l: OperationLogView) => l.id)).toEqual(['l1', 'l2'])
    expect(res.body.data.total).toBe(2)
    expect(h.logService.calls).toHaveLength(1)
  })

  it('forwards the requested page to the service', async () => {
    await request(h.app)
      .get('/admin/logs?page=3&pageSize=10')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)

    expect(h.logService.calls[0]).toEqual({ page: 3, pageSize: 10 })
  })

  it('defaults to page 1 when page is missing', async () => {
    await request(h.app).get('/admin/logs').set('Authorization', `Bearer ${ADMIN_TOKEN}`)
    expect(h.logService.calls[0]?.page).toBe(1)
  })

  it('returns an empty list when there are no logs', async () => {
    const res = await request(h.app)
      .get('/admin/logs')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(SUCCESS_CODE)
    expect(res.body.data.list).toEqual([])
    expect(res.body.data.total).toBe(0)
  })
})
