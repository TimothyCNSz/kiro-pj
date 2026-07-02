import { describe, it, expect } from 'vitest'

import {
  UploadService,
  type AuthContext,
  type PresignBackend,
  type PresignRequest,
} from './upload-service'
import { Role } from '../lib/domain'
import { ErrorCode } from '../lib/errors'
import { DEFAULT_MAX_IMAGE_BYTES, extFromContentType } from './s3-presign'
import { HttpError } from '../middleware/http-error'

// ---------------------------------------------------------------------------
// Fake S3 presign backend — deterministic keys/URLs, no real AWS. Records the
// arguments it receives so tests can assert delegation (需求 22.6, 22.7, 22.10).
// ---------------------------------------------------------------------------

class FakePresigner implements PresignBackend {
  readonly generateCalls: Array<{ objectKey: string; contentType: string; maxBytes?: number }> = []
  readonly keyCalls: Array<{ purpose: string; ownerId: string; ext: string }> = []

  extFromContentType(contentType: string): string | undefined {
    // Reuse the real mapping so tests stay faithful to supported types.
    return extFromContentType(contentType)
  }

  buildObjectKey(purpose: PresignRequest['purpose'], ownerId: string, ext: string): string {
    this.keyCalls.push({ purpose, ownerId, ext })
    return `${purpose === 'avatar' ? 'avatars' : 'products'}/${ownerId}/fixed-uuid.${ext}`
  }

  buildPublicUrl(objectKey: string): string {
    return `https://cdn.example.com/media/${objectKey}`
  }

  async generatePresignedPut(input: {
    objectKey: string
    contentType: string
    maxBytes?: number
  }): Promise<{ uploadUrl: string; objectKey: string }> {
    this.generateCalls.push(input)
    return { uploadUrl: `https://s3.example.com/${input.objectKey}?sig=x`, objectKey: input.objectKey }
  }
}

const admin: AuthContext = { userId: 'admin-1', role: Role.Admin }
const employee: AuthContext = { userId: 'emp-1', role: Role.Employee }

function buildService() {
  const presigner = new FakePresigner()
  const service = new UploadService({ presigner })
  return { presigner, service }
}

/** Assert the promise rejects with an HttpError carrying the given code. */
async function expectErrorCode(p: Promise<unknown>, code: ErrorCode) {
  await expect(p).rejects.toBeInstanceOf(HttpError)
  await expect(p).rejects.toMatchObject({ errorCode: code })
}

// ---------------------------------------------------------------------------
// Permission — 商品图需管理员; 头像限本人 (需求 22.1)
// ---------------------------------------------------------------------------

describe('UploadService.presign — 权限校验 (需求 22.1)', () => {
  it('rejects product upload by a non-admin with FORBIDDEN', async () => {
    const { service } = buildService()
    await expectErrorCode(
      service.presign(employee, {
        purpose: 'product',
        targetId: 'prod-9',
        contentType: 'image/png',
        size: 1000,
      }),
      ErrorCode.Forbidden,
    )
  })

  it('allows product upload by an admin', async () => {
    const { service } = buildService()
    const result = await service.presign(admin, {
      purpose: 'product',
      targetId: 'prod-9',
      contentType: 'image/png',
      size: 1000,
    })
    expect(result.objectKey).toBe('products/prod-9/fixed-uuid.png')
  })

  it('rejects avatar upload for another user with FORBIDDEN', async () => {
    const { service } = buildService()
    await expectErrorCode(
      service.presign(employee, {
        purpose: 'avatar',
        targetId: 'someone-else',
        contentType: 'image/jpeg',
        size: 1000,
      }),
      ErrorCode.Forbidden,
    )
  })

  it('allows avatar upload for oneself and uses userId as the owner', async () => {
    const { service, presigner } = buildService()
    const result = await service.presign(employee, {
      purpose: 'avatar',
      targetId: 'emp-1',
      contentType: 'image/jpeg',
      size: 1000,
    })
    expect(result.objectKey).toBe('avatars/emp-1/fixed-uuid.jpg')
    expect(presigner.keyCalls[0]).toEqual({ purpose: 'avatar', ownerId: 'emp-1', ext: 'jpg' })
  })
})

// ---------------------------------------------------------------------------
// Content type — {jpeg,png,webp} else UNSUPPORTED_IMAGE_TYPE (需求 22.2, 22.4)
// ---------------------------------------------------------------------------

describe('UploadService.presign — 格式校验 (需求 22.2, 22.4)', () => {
  const cases: Array<[string, string]> = [
    ['image/jpeg', 'jpg'],
    ['image/png', 'png'],
    ['image/webp', 'webp'],
  ]
  it.each(cases)('accepts supported content type %s', async (contentType, ext) => {
    const { service } = buildService()
    const result = await service.presign(admin, {
      purpose: 'product',
      targetId: 'p1',
      contentType,
      size: 1000,
    })
    expect(result.objectKey.endsWith(`.${ext}`)).toBe(true)
  })

  const rejected = ['image/gif', 'application/pdf', 'text/plain', 'image/svg+xml', '']
  it.each(rejected)('rejects unsupported content type "%s" with UNSUPPORTED_IMAGE_TYPE', async (ct) => {
    const { service } = buildService()
    await expectErrorCode(
      service.presign(admin, { purpose: 'product', targetId: 'p1', contentType: ct, size: 1000 }),
      ErrorCode.UnsupportedImageType,
    )
  })
})

// ---------------------------------------------------------------------------
// Size — 0 < size <= 5MB else IMAGE_TOO_LARGE (需求 22.3, 22.5)
// ---------------------------------------------------------------------------

describe('UploadService.presign — 大小校验 (需求 22.3, 22.5)', () => {
  it('accepts a size at the 5MB boundary', async () => {
    const { service } = buildService()
    const result = await service.presign(admin, {
      purpose: 'product',
      targetId: 'p1',
      contentType: 'image/png',
      size: DEFAULT_MAX_IMAGE_BYTES,
    })
    expect(result.uploadUrl).toContain('products/p1')
  })

  it('rejects a size just over 5MB with IMAGE_TOO_LARGE', async () => {
    const { service } = buildService()
    await expectErrorCode(
      service.presign(admin, {
        purpose: 'product',
        targetId: 'p1',
        contentType: 'image/png',
        size: DEFAULT_MAX_IMAGE_BYTES + 1,
      }),
      ErrorCode.ImageTooLarge,
    )
  })

  it.each([0, -1])('rejects a non-positive size %s with IMAGE_TOO_LARGE', async (size) => {
    const { service } = buildService()
    await expectErrorCode(
      service.presign(admin, { purpose: 'product', targetId: 'p1', contentType: 'image/png', size }),
      ErrorCode.ImageTooLarge,
    )
  })

  it('honors a custom maxBytes bound', async () => {
    const presigner = new FakePresigner()
    const service = new UploadService({ presigner, maxBytes: 100 })
    await expectErrorCode(
      service.presign(admin, { purpose: 'product', targetId: 'p1', contentType: 'image/png', size: 101 }),
      ErrorCode.ImageTooLarge,
    )
  })
})

// ---------------------------------------------------------------------------
// Ordering + delegation
// ---------------------------------------------------------------------------

describe('UploadService.presign — 校验顺序与委托', () => {
  it('checks permission before format/size (FORBIDDEN wins over bad type)', async () => {
    const { service, presigner } = buildService()
    await expectErrorCode(
      service.presign(employee, {
        purpose: 'product',
        targetId: 'p1',
        contentType: 'image/gif',
        size: DEFAULT_MAX_IMAGE_BYTES + 999,
      }),
      ErrorCode.Forbidden,
    )
    // No presign attempted on rejection.
    expect(presigner.generateCalls).toEqual([])
  })

  it('does not sign a URL when validation fails', async () => {
    const { service, presigner } = buildService()
    await expectErrorCode(
      service.presign(admin, { purpose: 'product', targetId: 'p1', contentType: 'image/gif', size: 1 }),
      ErrorCode.UnsupportedImageType,
    )
    expect(presigner.generateCalls).toEqual([])
  })

  it('delegates to the presign backend with the fixed content type and max bytes on success', async () => {
    const { service, presigner } = buildService()
    const result = await service.presign(admin, {
      purpose: 'product',
      targetId: 'p1',
      contentType: 'image/webp',
      size: 2048,
    })
    expect(presigner.generateCalls).toEqual([
      { objectKey: 'products/p1/fixed-uuid.webp', contentType: 'image/webp', maxBytes: DEFAULT_MAX_IMAGE_BYTES },
    ])
    expect(result.publicUrl).toBe('https://cdn.example.com/media/products/p1/fixed-uuid.webp')
  })
})
