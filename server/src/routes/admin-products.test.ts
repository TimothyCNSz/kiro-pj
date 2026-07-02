// Route tests for /admin/products (创建/编辑/上下架, 需求 12.1, 12.3–12.5, 3.4, 20.4)。
//
// 依赖以内存/替身注入（服务、认证中间件），不触达真实数据库/JWT/AWS。

import { describe, it, expect, beforeEach } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'

import {
  createAdminProductsRouter,
  PRODUCT_CREATED_MESSAGE,
  PRODUCT_UPDATED_MESSAGE,
  PRODUCT_STATUS_UPDATED_MESSAGE,
  type AdminProductCommandService,
} from './admin-products'
import { createAuthMiddleware, type JwtVerifier } from '../middleware/auth'
import { errorHandler, notFoundHandler, NOT_FOUND_CODE } from '../middleware/error-handler'
import { SUCCESS_CODE } from '../lib/api'
import { ProductStatus, ProductType, Role } from '../lib/domain'
import { ErrorCode, ERROR_DEFINITIONS } from '../lib/errors'
import {
  ProductValidationError,
  type CreateProductInput,
  type UpdateProductPatch,
} from '../services/admin-product-service'
import type { Product } from '../db/schema'
import type { AuthTokenPayload } from '../services/auth-service'
import type { SessionManager, SessionRecord, CreatedSession } from '../services/session-service'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const sampleProduct = (over: Partial<Product> = {}): Product => ({
  id: 'prod-1',
  name: 'p',
  imageUrl: null,
  description: '',
  pointsCost: 100,
  type: ProductType.Physical,
  status: ProductStatus.Unlisted,
  stock: 0,
  version: 0,
  createdAt: new Date(),
  ...over,
})

class FakeAdminProductService implements AdminProductCommandService {
  createResult: Product = sampleProduct()
  createError: unknown = null
  updateResult: Product | null = sampleProduct({ name: 'renamed' })
  setStatusResult: Product | null = sampleProduct({ status: ProductStatus.Listed })

  readonly created: CreateProductInput[] = []
  readonly updated: Array<{ id: string; patch: UpdateProductPatch }> = []
  readonly statusCalls: Array<{ id: string; status: ProductStatus }> = []

  async create(input: CreateProductInput): Promise<Product> {
    this.created.push(input)
    if (this.createError) throw this.createError
    return this.createResult
  }
  async update(id: string, patch: UpdateProductPatch): Promise<Product | null> {
    this.updated.push({ id, patch })
    return this.updateResult
  }
  async setStatus(id: string, status: ProductStatus): Promise<Product | null> {
    this.statusCalls.push({ id, status })
    return this.setStatusResult
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

const ADMIN: AuthTokenPayload = { sub: 'admin-1', sid: 'sid-admin', role: Role.Admin }
const EMPLOYEE: AuthTokenPayload = { sub: 'emp-1', sid: 'sid-emp', role: Role.Employee }

interface Harness {
  app: Express
  service: FakeAdminProductService
}

function buildHarness(): Harness {
  const service = new FakeAdminProductService()
  const authMiddleware = createAuthMiddleware({
    verifier: new FakeVerifier({ 'admin-tok': ADMIN, 'emp-tok': EMPLOYEE }),
    sessionManager: new FakeSessionManager(new Set(['sid-admin', 'sid-emp'])),
  })

  const router = createAdminProductsRouter({ service, authMiddleware })

  const app = express()
  app.use(express.json())
  app.use('/admin/products', router)
  app.use(notFoundHandler)
  app.use(errorHandler)

  return { app, service }
}

const codeOf = (c: ErrorCode) => ERROR_DEFINITIONS[c].appCode
const asAdmin = (r: request.Test) => r.set('Authorization', 'Bearer admin-tok')

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /admin/products', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })

  it('creates a product and returns 201 (需求 12.1)', async () => {
    h.service.createResult = sampleProduct({ id: 'p9', name: '马克杯', pointsCost: 100 })
    const res = await asAdmin(
      request(h.app)
        .post('/admin/products')
        .send({ name: '马克杯', pointsCost: 100, type: ProductType.Physical }),
    )
    expect(res.status).toBe(201)
    expect(res.body.code).toBe(SUCCESS_CODE)
    expect(res.body.message).toBe(PRODUCT_CREATED_MESSAGE)
    expect(res.body.data.id).toBe('p9')
    expect(h.service.created[0]).toMatchObject({ name: '马克杯', pointsCost: 100 })
  })

  it('maps a validation failure to 422 INVALID_PRODUCT_FIELD (需求 12.5)', async () => {
    h.service.createError = new ProductValidationError({ pointsCost: 'NEGATIVE_OR_INVALID' })
    const res = await asAdmin(
      request(h.app)
        .post('/admin/products')
        .send({ name: 'x', pointsCost: -1, type: ProductType.Physical }),
    )
    expect(res.status).toBe(422)
    expect(res.body.code).toBe(codeOf(ErrorCode.InvalidProductField))
  })

  it('requires authentication (需求 20.1)', async () => {
    const res = await request(h.app)
      .post('/admin/products')
      .send({ name: 'x', pointsCost: 1, type: ProductType.Physical })
    expect(res.status).toBe(401)
    expect(res.body.code).toBe(codeOf(ErrorCode.Unauthenticated))
    expect(h.service.created).toEqual([])
  })

  it('forbids non-admin employees (需求 3.4, 20.4)', async () => {
    const res = await request(h.app)
      .post('/admin/products')
      .set('Authorization', 'Bearer emp-tok')
      .send({ name: 'x', pointsCost: 1, type: ProductType.Physical })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe(codeOf(ErrorCode.Forbidden))
    expect(h.service.created).toEqual([])
  })
})

describe('PUT /admin/products/:id', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })

  it('updates a product and returns 200 (需求 12.3)', async () => {
    h.service.updateResult = sampleProduct({ id: 'p1', name: 'renamed' })
    const res = await asAdmin(
      request(h.app).put('/admin/products/p1').send({ name: 'renamed' }),
    )
    expect(res.status).toBe(200)
    expect(res.body.message).toBe(PRODUCT_UPDATED_MESSAGE)
    expect(res.body.data.name).toBe('renamed')
    expect(h.service.updated[0]).toEqual({ id: 'p1', patch: { name: 'renamed' } })
  })

  it('returns 404 when the product does not exist', async () => {
    h.service.updateResult = null
    const res = await asAdmin(
      request(h.app).put('/admin/products/missing').send({ name: 'x' }),
    )
    expect(res.status).toBe(404)
    expect(res.body.code).toBe(NOT_FOUND_CODE)
  })

  it('forbids non-admin employees (需求 3.4, 20.4)', async () => {
    const res = await request(h.app)
      .put('/admin/products/p1')
      .set('Authorization', 'Bearer emp-tok')
      .send({ name: 'x' })
    expect(res.status).toBe(403)
    expect(h.service.updated).toEqual([])
  })
})

describe('PATCH /admin/products/:id/status', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })

  it('switches product status and returns 200 (需求 12.4)', async () => {
    h.service.setStatusResult = sampleProduct({ id: 'p1', status: ProductStatus.Listed })
    const res = await asAdmin(
      request(h.app).patch('/admin/products/p1/status').send({ status: ProductStatus.Listed }),
    )
    expect(res.status).toBe(200)
    expect(res.body.message).toBe(PRODUCT_STATUS_UPDATED_MESSAGE)
    expect(res.body.data.status).toBe(ProductStatus.Listed)
    expect(h.service.statusCalls[0]).toEqual({ id: 'p1', status: ProductStatus.Listed })
  })

  it('returns 404 when the product does not exist', async () => {
    h.service.setStatusResult = null
    const res = await asAdmin(
      request(h.app)
        .patch('/admin/products/missing/status')
        .send({ status: ProductStatus.Unlisted }),
    )
    expect(res.status).toBe(404)
    expect(res.body.code).toBe(NOT_FOUND_CODE)
  })

  it('forbids non-admin employees (需求 3.4, 20.4)', async () => {
    const res = await request(h.app)
      .patch('/admin/products/p1/status')
      .set('Authorization', 'Bearer emp-tok')
      .send({ status: ProductStatus.Listed })
    expect(res.status).toBe(403)
    expect(h.service.statusCalls).toEqual([])
  })
})
