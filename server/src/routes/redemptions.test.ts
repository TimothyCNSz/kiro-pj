import { describe, it, expect, beforeEach } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'

import {
  createRedemptionsRouter,
  type CartItemsReader,
  type RedemptionExecutor,
} from './redemptions'
import { createAuthMiddleware, type JwtVerifier } from '../middleware/auth'
import { errorHandler, notFoundHandler } from '../middleware/error-handler'
import { SUCCESS_CODE } from '../lib/api'
import { ProductType, Role } from '../lib/domain'
import { ErrorCode, ERROR_DEFINITIONS } from '../lib/errors'
import { HttpError } from '../middleware/http-error'
import type { AuthTokenPayload } from '../services/auth-service'
import type { SessionManager, SessionRecord, CreatedSession } from '../services/session-service'
import type { CheckoutOptions, CheckoutResult, RedeemItem } from '../services/redemption-service'

// ---------------------------------------------------------------------------
// Fakes — in-memory executors + cart reader; auth stubbed with deterministic
// verifier + session manager (no real DB).
// ---------------------------------------------------------------------------

class FakeExecutor implements RedemptionExecutor {
  nextError: HttpError | null = null
  result: CheckoutResult = {
    userId: 'user-1',
    lines: [],
    totalCost: 0,
    balanceBefore: 0,
    balanceAfter: 0,
  }
  readonly calls: Array<{ userId: string; items: RedeemItem[]; options?: CheckoutOptions }> = []

  async checkout(
    userId: string,
    items: readonly RedeemItem[],
    options?: CheckoutOptions,
  ): Promise<CheckoutResult> {
    this.calls.push({ userId, items: [...items], options })
    if (this.nextError) {
      const err = this.nextError
      this.nextError = null
      throw err
    }
    return this.result
  }
}

class FakeCartReader implements CartItemsReader {
  items: Array<{ productId: string; quantity: number }> = []
  readonly calls: string[] = []
  async getCart(userId: string) {
    this.calls.push(userId)
    return { items: this.items }
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
  checkout: FakeExecutor
  instant: FakeExecutor
  cart: FakeCartReader
}

function buildHarness(): Harness {
  const checkout = new FakeExecutor()
  const instant = new FakeExecutor()
  const cart = new FakeCartReader()
  const authMiddleware = createAuthMiddleware({
    verifier: new FakeVerifier({ 'tok-ok': PAYLOAD }),
    sessionManager: new FakeSessionManager(new Set(['sid-ok'])),
  })
  const router = createRedemptionsRouter({
    checkoutService: checkout,
    instantService: instant,
    cartReader: cart,
    authMiddleware,
  })

  const app = express()
  app.use(express.json())
  app.use('/redemptions', router)
  app.use(notFoundHandler)
  app.use(errorHandler)

  return { app, checkout, instant, cart }
}

const auth = (r: request.Test) => r.set('Authorization', 'Bearer tok-ok')
const codeOf = (c: ErrorCode) => ERROR_DEFINITIONS[c].appCode

const sampleResult: CheckoutResult = {
  userId: 'user-1',
  totalCost: 450,
  balanceBefore: 1000,
  balanceAfter: 550,
  lines: [
    {
      productId: 'p1',
      quantity: 2,
      cost: 200,
      product: { id: 'p1', name: 'Mug', type: ProductType.Physical, pointsCost: 100, stock: 10, version: 0 },
    },
    {
      productId: 'v1',
      quantity: 1,
      cost: 250,
      product: { id: 'v1', name: 'Card', type: ProductType.Virtual, pointsCost: 250, stock: 5, version: 0 },
    },
  ],
}

// ---------------------------------------------------------------------------
// Authentication (需求 1.15)
// ---------------------------------------------------------------------------

describe('redemption routes require authentication (需求 1.15)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })

  it('rejects POST /redemptions/checkout without a token', async () => {
    const res = await request(h.app).post('/redemptions/checkout').send({})
    expect(res.status).toBe(401)
    expect(res.body.code).toBe(codeOf(ErrorCode.Unauthenticated))
  })

  it('rejects POST /redemptions/instant without a token', async () => {
    const res = await request(h.app).post('/redemptions/instant').send({ productId: 'p1' })
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// POST /redemptions/checkout (需求 7.1, 7.3, 7.4, 7.5, 7.9)
// ---------------------------------------------------------------------------

describe('POST /redemptions/checkout', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })

  it('gathers cart items and checks out, returning 201 with a redemption summary', async () => {
    h.cart.items = [
      { productId: 'p1', quantity: 2 },
      { productId: 'v1', quantity: 1 },
    ]
    h.checkout.result = sampleResult

    const address = { recipient: 'Ada', phone: '123', detail: 'HQ' }
    const res = await auth(request(h.app).post('/redemptions/checkout')).send({ address })

    expect(res.status).toBe(201)
    expect(res.body.code).toBe(SUCCESS_CODE)
    expect(res.body.data.totalCost).toBe(450)
    expect(res.body.data.balanceAfter).toBe(550)
    expect(res.body.data.items).toHaveLength(2)

    // cart items forwarded to the checkout executor with the address option.
    expect(h.cart.calls).toEqual(['user-1'])
    expect(h.checkout.calls).toHaveLength(1)
    expect(h.checkout.calls[0].userId).toBe('user-1')
    expect(h.checkout.calls[0].items).toEqual([
      { productId: 'p1', quantity: 2 },
      { productId: 'v1', quantity: 1 },
    ])
    expect(h.checkout.calls[0].options?.address).toEqual(address)
    // instant executor untouched.
    expect(h.instant.calls).toEqual([])
  })

  it('maps INSUFFICIENT_POINTS from the service to 409', async () => {
    h.cart.items = [{ productId: 'p1', quantity: 2 }]
    h.checkout.nextError = new HttpError(ErrorCode.InsufficientPoints, '积分不足')
    const res = await auth(request(h.app).post('/redemptions/checkout')).send({})
    expect(res.status).toBe(ERROR_DEFINITIONS[ErrorCode.InsufficientPoints].httpStatus)
    expect(res.body.code).toBe(codeOf(ErrorCode.InsufficientPoints))
  })

  it('maps ADDRESS_REQUIRED from the service to 422', async () => {
    h.cart.items = [{ productId: 'p1', quantity: 1 }]
    h.checkout.nextError = new HttpError(ErrorCode.AddressRequired, '请填写配送地址')
    const res = await auth(request(h.app).post('/redemptions/checkout')).send({})
    expect(res.status).toBe(422)
    expect(res.body.code).toBe(codeOf(ErrorCode.AddressRequired))
  })
})

// ---------------------------------------------------------------------------
// POST /redemptions/instant (需求 7.2, 7.4, 7.8)
// ---------------------------------------------------------------------------

describe('POST /redemptions/instant', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })

  it('redeems a single product with an explicit quantity', async () => {
    h.instant.result = sampleResult
    const res = await auth(request(h.app).post('/redemptions/instant')).send({
      productId: 'p1',
      quantity: 3,
    })
    expect(res.status).toBe(201)
    expect(res.body.code).toBe(SUCCESS_CODE)
    expect(h.instant.calls).toHaveLength(1)
    expect(h.instant.calls[0].items).toEqual([{ productId: 'p1', quantity: 3 }])
    // checkout executor & cart reader untouched for instant redemption.
    expect(h.checkout.calls).toEqual([])
    expect(h.cart.calls).toEqual([])
  })

  it('defaults quantity to 1 when omitted', async () => {
    const res = await auth(request(h.app).post('/redemptions/instant')).send({ productId: 'p1' })
    expect(res.status).toBe(201)
    expect(h.instant.calls[0].items).toEqual([{ productId: 'p1', quantity: 1 }])
  })

  it('forwards the address option for physical instant redemptions', async () => {
    const address = { recipient: 'Ada', phone: '123', detail: 'HQ' }
    await auth(request(h.app).post('/redemptions/instant')).send({ productId: 'p1', address })
    expect(h.instant.calls[0].options?.address).toEqual(address)
  })

  it('rejects a missing productId with VALIDATION (422)', async () => {
    const res = await auth(request(h.app).post('/redemptions/instant')).send({ quantity: 1 })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe(codeOf(ErrorCode.Validation))
    expect(h.instant.calls).toEqual([])
  })

  it('rejects an invalid quantity with VALIDATION (422)', async () => {
    const res = await auth(request(h.app).post('/redemptions/instant')).send({
      productId: 'p1',
      quantity: 0,
    })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe(codeOf(ErrorCode.Validation))
    expect(h.instant.calls).toEqual([])
  })

  it('maps INSUFFICIENT_STOCK from the service to 409', async () => {
    h.instant.nextError = new HttpError(ErrorCode.InsufficientStock, '库存不足')
    const res = await auth(request(h.app).post('/redemptions/instant')).send({ productId: 'p1' })
    expect(res.status).toBe(ERROR_DEFINITIONS[ErrorCode.InsufficientStock].httpStatus)
    expect(res.body.code).toBe(codeOf(ErrorCode.InsufficientStock))
  })
})
