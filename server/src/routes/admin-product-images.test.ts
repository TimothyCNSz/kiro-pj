import { describe, it, expect, beforeEach } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'

import {
  createAdminProductImagesRouter,
  type ProductImageCommandService,
  IMAGE_ADDED_MESSAGE,
  PRIMARY_SET_MESSAGE,
  IMAGE_REMOVED_MESSAGE,
  IMAGE_NOT_FOUND_MESSAGE,
} from './admin-product-images'
import { createAuthMiddleware, type JwtVerifier } from '../middleware/auth'
import { errorHandler, notFoundHandler, NOT_FOUND_CODE } from '../middleware/error-handler'
import { HttpError } from '../middleware/http-error'
import { SUCCESS_CODE } from '../lib/api'
import { Role } from '../lib/domain'
import { ErrorCode, ERROR_DEFINITIONS } from '../lib/errors'
import type { AuthTokenPayload } from '../services/auth-service'
import type { SessionManager, SessionRecord, CreatedSession } from '../services/session-service'
import type { ProductImage } from '../db/schema'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const sampleImage = (over: Partial<ProductImage> = {}): ProductImage => ({
  id: 'img-1',
  productId: 'p1',
  objectKey: 'products/p1/a.png',
  url: 'https://cdn/media/products/p1/a.png',
  isPrimary: true,
  sortOrder: 0,
  createdAt: new Date('2024-01-01T00:00:00Z'),
  ...over,
})

class FakeProductImageService implements ProductImageCommandService {
  readonly addCalls: Array<{ productId: string; objectKey: string; url: string }> = []
  readonly setPrimaryCalls: Array<{ productId: string; imageId: string }> = []
  readonly removeCalls: Array<{ productId: string; imageId: string }> = []

  addResult: ProductImage = sampleImage()
  addError: unknown = null
  setPrimaryResult = true
  removeResult = true

  async addImage(productId: string, objectKey: string, url: string): Promise<ProductImage> {
    this.addCalls.push({ productId, objectKey, url })
    if (this.addError) throw this.addError
    return this.addResult
  }

  async setPrimary(productId: string, imageId: string): Promise<boolean> {
    this.setPrimaryCalls.push({ productId, imageId })
    return this.setPrimaryResult
  }

  async removeImage(productId: string, imageId: string): Promise<boolean> {
    this.removeCalls.push({ productId, imageId })
    return this.removeResult
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
  service: FakeProductImageService
}

function buildHarness(): Harness {
  const service = new FakeProductImageService()
  const authMiddleware = createAuthMiddleware({
    verifier: new FakeVerifier({
      [ADMIN_TOKEN]: { sub: 'admin-1', sid: 'sid-admin', role: Role.Admin },
      [EMPLOYEE_TOKEN]: { sub: 'emp-1', sid: 'sid-emp', role: Role.Employee },
    }),
    sessionManager: new FakeSessionManager(new Set(['sid-admin', 'sid-emp'])),
  })

  const router = createAdminProductImagesRouter({ service, authMiddleware })

  const app = express()
  app.use(express.json())
  app.use('/admin/products', router)
  app.use(notFoundHandler)
  app.use(errorHandler)

  return { app, service }
}

const codeOf = (c: ErrorCode) => ERROR_DEFINITIONS[c].appCode
const auth = (t: string) => ({ Authorization: `Bearer ${t}` })

// ---------------------------------------------------------------------------
// POST /:id/images
// ---------------------------------------------------------------------------

describe('POST /admin/products/:id/images', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })

  it('rejects unauthenticated requests with 401 (需求 20.1, 20.3)', async () => {
    const res = await request(h.app)
      .post('/admin/products/p1/images')
      .send({ objectKey: 'k', url: 'u' })
    expect(res.status).toBe(401)
    expect(res.body.code).toBe(codeOf(ErrorCode.Unauthenticated))
    expect(h.service.addCalls).toEqual([])
  })

  it('rejects non-admin (employee) requests with 403 (需求 3.3, 20.4)', async () => {
    const res = await request(h.app)
      .post('/admin/products/p1/images')
      .set(auth(EMPLOYEE_TOKEN))
      .send({ objectKey: 'k', url: 'u' })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe(codeOf(ErrorCode.Forbidden))
    expect(h.service.addCalls).toEqual([])
  })

  it('associates an image for an admin and returns 201 + envelope (需求 12.7, 22.9)', async () => {
    h.service.addResult = sampleImage({ id: 'img-9', isPrimary: false, sortOrder: 3 })
    const res = await request(h.app)
      .post('/admin/products/p1/images')
      .set(auth(ADMIN_TOKEN))
      .send({ objectKey: 'products/p1/x.png', url: 'https://cdn/x.png' })

    expect(res.status).toBe(201)
    expect(res.body.code).toBe(SUCCESS_CODE)
    expect(res.body.message).toBe(IMAGE_ADDED_MESSAGE)
    expect(res.body.data.id).toBe('img-9')
    expect(h.service.addCalls).toEqual([
      { productId: 'p1', objectKey: 'products/p1/x.png', url: 'https://cdn/x.png' },
    ])
  })

  it('maps IMAGE_LIMIT_EXCEEDED to 409 (需求 22.11, 22.12)', async () => {
    h.service.addError = new HttpError(ErrorCode.ImageLimitExceeded, 'limit')
    const res = await request(h.app)
      .post('/admin/products/p1/images')
      .set(auth(ADMIN_TOKEN))
      .send({ objectKey: 'k', url: 'u' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe(codeOf(ErrorCode.ImageLimitExceeded))
  })
})

// ---------------------------------------------------------------------------
// PATCH /:id/images/:imageId/primary
// ---------------------------------------------------------------------------

describe('PATCH /admin/products/:id/images/:imageId/primary', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })

  it('sets the primary image for an admin (需求 12.8, 12.9)', async () => {
    const res = await request(h.app)
      .patch('/admin/products/p1/images/img-2/primary')
      .set(auth(ADMIN_TOKEN))
      .send()
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(SUCCESS_CODE)
    expect(res.body.message).toBe(PRIMARY_SET_MESSAGE)
    expect(h.service.setPrimaryCalls).toEqual([{ productId: 'p1', imageId: 'img-2' }])
  })

  it('returns 404 when the image does not exist', async () => {
    h.service.setPrimaryResult = false
    const res = await request(h.app)
      .patch('/admin/products/p1/images/missing/primary')
      .set(auth(ADMIN_TOKEN))
      .send()
    expect(res.status).toBe(404)
    expect(res.body.code).toBe(NOT_FOUND_CODE)
    expect(res.body.message).toBe(IMAGE_NOT_FOUND_MESSAGE)
  })

  it('rejects non-admin requests with 403', async () => {
    const res = await request(h.app)
      .patch('/admin/products/p1/images/img-2/primary')
      .set(auth(EMPLOYEE_TOKEN))
      .send()
    expect(res.status).toBe(403)
    expect(h.service.setPrimaryCalls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// DELETE /:id/images/:imageId
// ---------------------------------------------------------------------------

describe('DELETE /admin/products/:id/images/:imageId', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })

  it('removes an image for an admin (需求 12.7)', async () => {
    const res = await request(h.app)
      .delete('/admin/products/p1/images/img-3')
      .set(auth(ADMIN_TOKEN))
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(SUCCESS_CODE)
    expect(res.body.message).toBe(IMAGE_REMOVED_MESSAGE)
    expect(h.service.removeCalls).toEqual([{ productId: 'p1', imageId: 'img-3' }])
  })

  it('returns 404 when the image does not exist', async () => {
    h.service.removeResult = false
    const res = await request(h.app)
      .delete('/admin/products/p1/images/missing')
      .set(auth(ADMIN_TOKEN))
    expect(res.status).toBe(404)
    expect(res.body.code).toBe(NOT_FOUND_CODE)
    expect(res.body.message).toBe(IMAGE_NOT_FOUND_MESSAGE)
  })

  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(h.app).delete('/admin/products/p1/images/img-3')
    expect(res.status).toBe(401)
    expect(h.service.removeCalls).toEqual([])
  })
})
