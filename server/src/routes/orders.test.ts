import { describe, it, expect, beforeEach } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'

import { createOrdersRouter, createPointsRouter, type OrderHistoryQueryService } from './orders'
import { createAuthMiddleware, type JwtVerifier } from '../middleware/auth'
import { errorHandler, notFoundHandler, NOT_FOUND_CODE } from '../middleware/error-handler'
import { SUCCESS_CODE, type PaginatedData } from '../lib/api'
import { Role, OrderStatus, OrderType } from '../lib/domain'
import { ErrorCode, ERROR_DEFINITIONS } from '../lib/errors'
import type { AuthTokenPayload } from '../services/auth-service'
import type { SessionManager, SessionRecord, CreatedSession } from '../services/session-service'
import type { OrderDetailView, OrderHistoryItem } from '../services/order-history-service'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const emptyPage: PaginatedData<OrderHistoryItem> = { list: [], total: 0, page: 1, pageSize: 20 }

class FakeOrderHistoryService implements OrderHistoryQueryService {
  listResult: PaginatedData<OrderHistoryItem> = emptyPage
  detailResult: OrderDetailView | null = null
  balanceResult = 0

  readonly listCalls: Array<{ userId: string; page: number; pageSize: number }> = []
  readonly getCalls: Array<{ userId: string; orderId: string }> = []
  readonly balanceCalls: string[] = []

  async listOrders(userId: string, p: { page: number; pageSize: number }) {
    this.listCalls.push({ userId, ...p })
    return this.listResult
  }
  async getOrder(userId: string, orderId: string) {
    this.getCalls.push({ userId, orderId })
    return this.detailResult
  }
  async getBalance(userId: string) {
    this.balanceCalls.push(userId)
    return this.balanceResult
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
  svc: FakeOrderHistoryService
}

function buildHarness(): Harness {
  const svc = new FakeOrderHistoryService()
  const authMiddleware = createAuthMiddleware({
    verifier: new FakeVerifier({ 'tok-ok': PAYLOAD }),
    sessionManager: new FakeSessionManager(new Set(['sid-ok'])),
  })

  const app = express()
  app.use(express.json())
  app.use('/orders', createOrdersRouter({ orderHistoryService: svc, authMiddleware }))
  app.use('/points', createPointsRouter({ orderHistoryService: svc, authMiddleware }))
  app.use(notFoundHandler)
  app.use(errorHandler)

  return { app, svc }
}

const auth = (r: request.Test) => r.set('Authorization', 'Bearer tok-ok')
const codeOf = (c: ErrorCode) => ERROR_DEFINITIONS[c].appCode

const sampleItem: OrderHistoryItem = {
  id: 'o1',
  type: OrderType.Physical,
  status: OrderStatus.PendingShipment,
  pointsSpent: 100,
  createdAt: new Date('2024-01-01T00:00:00Z'),
  items: [{ productId: 'p1', productName: 'Mug', quantity: 1, unitPoints: 100 }],
}

// ---------------------------------------------------------------------------
// Authentication (需求 1.15)
// ---------------------------------------------------------------------------

describe('orders/points routes require authentication (需求 1.15)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })

  it('rejects GET /orders without a token', async () => {
    const res = await request(h.app).get('/orders')
    expect(res.status).toBe(401)
    expect(res.body.code).toBe(codeOf(ErrorCode.Unauthenticated))
  })

  it('rejects GET /orders/:id without a token', async () => {
    const res = await request(h.app).get('/orders/o1')
    expect(res.status).toBe(401)
  })

  it('rejects GET /points/balance without a token', async () => {
    const res = await request(h.app).get('/points/balance')
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// GET /orders (需求 11.1–11.4)
// ---------------------------------------------------------------------------

describe('GET /orders', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })

  it('returns a paginated envelope scoped to the authenticated user (需求 11.1)', async () => {
    h.svc.listResult = { list: [sampleItem], total: 1, page: 1, pageSize: 20 }
    const res = await auth(request(h.app).get('/orders'))
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(SUCCESS_CODE)
    expect(res.body.data.total).toBe(1)
    expect(res.body.data.list[0].id).toBe('o1')
    expect(h.svc.listCalls[0].userId).toBe('user-1')
  })

  it('forwards parsed pagination to the service (需求 11.3)', async () => {
    await auth(request(h.app).get('/orders').query({ page: '2', pageSize: '5' }))
    expect(h.svc.listCalls).toEqual([{ userId: 'user-1', page: 2, pageSize: 5 }])
  })

  it('returns an empty list envelope for a user with no history (需求 11.4)', async () => {
    const res = await auth(request(h.app).get('/orders'))
    expect(res.status).toBe(200)
    expect(res.body.data.list).toEqual([])
    expect(res.body.data.total).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// GET /orders/:id (需求 8.3, 9.3, 9.4)
// ---------------------------------------------------------------------------

describe('GET /orders/:id', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })

  it('returns the order detail when found and owned by the user', async () => {
    const detail: OrderDetailView = {
      ...sampleItem,
      type: OrderType.Virtual,
      status: OrderStatus.Shipped,
      shippingAddress: null,
      trackingNo: null,
      cdks: ['CODE-1'],
    }
    h.svc.detailResult = detail
    const res = await auth(request(h.app).get('/orders/o1'))
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(SUCCESS_CODE)
    expect(res.body.data.cdks).toEqual(['CODE-1'])
    expect(h.svc.getCalls).toEqual([{ userId: 'user-1', orderId: 'o1' }])
  })

  it('returns 404 when the order does not exist or is not owned by the user', async () => {
    h.svc.detailResult = null
    const res = await auth(request(h.app).get('/orders/missing'))
    expect(res.status).toBe(404)
    expect(res.body.code).toBe(NOT_FOUND_CODE)
  })
})

// ---------------------------------------------------------------------------
// GET /points/balance (需求 10.1–10.3)
// ---------------------------------------------------------------------------

describe('GET /points/balance', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })

  it('returns the current balance for the authenticated user (需求 10.1)', async () => {
    h.svc.balanceResult = 1250
    const res = await auth(request(h.app).get('/points/balance'))
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(SUCCESS_CODE)
    expect(res.body.data).toEqual({ balance: 1250 })
    expect(h.svc.balanceCalls).toEqual(['user-1'])
  })
})
