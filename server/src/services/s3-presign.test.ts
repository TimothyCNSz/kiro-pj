import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { describe, expect, it, vi } from 'vitest'

import {
  CONTENT_TYPE_TO_EXT,
  DEFAULT_MAX_IMAGE_BYTES,
  PRESIGN_EXPIRY_SECONDS,
  S3PresignService,
  buildObjectKey,
  buildPublicUrl,
  extFromContentType,
  type PresignSigner,
} from './s3-presign'

/** A fake S3 client sentinel; the presigner is stubbed so it is never used. */
const fakeClient = {} as unknown as S3Client

/** Records the last presign invocation and returns a deterministic fake URL. */
const makeSpySigner = () => {
  const calls: Array<{ command: PutObjectCommand; expiresIn: number }> = []
  const signer: PresignSigner = vi.fn(async (_client, command, options) => {
    calls.push({ command, expiresIn: options.expiresIn })
    return `https://s3.example/signed?key=${encodeURIComponent(command.input.Key ?? '')}`
  })
  return { signer, calls }
}

describe('extFromContentType', () => {
  it('maps supported image content types to extensions', () => {
    expect(extFromContentType('image/jpeg')).toBe('jpg')
    expect(extFromContentType('image/png')).toBe('png')
    expect(extFromContentType('image/webp')).toBe('webp')
  })

  it('is case- and whitespace-insensitive', () => {
    expect(extFromContentType('  IMAGE/JPEG ')).toBe('jpg')
  })

  it('returns undefined for unsupported types', () => {
    expect(extFromContentType('image/gif')).toBeUndefined()
    expect(extFromContentType('application/pdf')).toBeUndefined()
    expect(extFromContentType('')).toBeUndefined()
  })

  it('keeps the mapping table in sync', () => {
    expect(CONTENT_TYPE_TO_EXT).toEqual({
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
    })
  })
})

describe('buildObjectKey', () => {
  const uuidV4 = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/

  it('builds avatar keys as avatars/{userId}/{uuid}.{ext}', () => {
    const key = buildObjectKey('avatar', 'user-123', 'jpg')
    expect(key).toMatch(new RegExp(`^avatars/user-123/${uuidV4.source}\\.jpg$`))
  })

  it('builds product keys as products/{productId}/{uuid}.{ext}', () => {
    const key = buildObjectKey('product', 'prod-abc', 'webp')
    expect(key).toMatch(new RegExp(`^products/prod-abc/${uuidV4.source}\\.webp$`))
  })

  it('produces a unique key per invocation', () => {
    const a = buildObjectKey('avatar', 'u', 'png')
    const b = buildObjectKey('avatar', 'u', 'png')
    expect(a).not.toBe(b)
  })
})

describe('buildPublicUrl', () => {
  it('joins base + /media/<objectKey>', () => {
    expect(buildPublicUrl('avatars/u/x.jpg', 'https://media.example.com')).toBe(
      'https://media.example.com/media/avatars/u/x.jpg',
    )
  })

  it('normalizes a trailing slash on the base and a leading slash on the key', () => {
    expect(buildPublicUrl('/products/p/y.png', 'https://media.example.com/')).toBe(
      'https://media.example.com/media/products/p/y.png',
    )
  })
})

describe('S3PresignService.generatePresignedPut', () => {
  it('signs a PutObjectCommand with a 5-minute expiry and fixed Content-Type', async () => {
    const { signer, calls } = makeSpySigner()
    const service = new S3PresignService({
      client: fakeClient,
      signer,
      bucket: 'uploads-bucket',
    })

    const result = await service.generatePresignedPut({
      objectKey: 'avatars/user-1/abc.jpg',
      contentType: 'image/jpeg',
    })

    expect(calls).toHaveLength(1)
    // 5-minute (300s) expiry — 需求 22.6/22.8.
    expect(calls[0].expiresIn).toBe(PRESIGN_EXPIRY_SECONDS)
    expect(calls[0].expiresIn).toBe(300)

    const command = calls[0].command
    expect(command).toBeInstanceOf(PutObjectCommand)
    expect(command.input.Bucket).toBe('uploads-bucket')
    expect(command.input.Key).toBe('avatars/user-1/abc.jpg')
    expect(command.input.ContentType).toBe('image/jpeg')

    expect(result.uploadUrl).toContain('https://s3.example/signed')
    expect(result.objectKey).toBe('avatars/user-1/abc.jpg')
    expect(result.contentType).toBe('image/jpeg')
    expect(result.expiresIn).toBe(300)
    expect(result.maxBytes).toBe(DEFAULT_MAX_IMAGE_BYTES)
  })

  it('carries a custom content-length-range max through to the result', async () => {
    const { signer } = makeSpySigner()
    const service = new S3PresignService({
      client: fakeClient,
      signer,
      bucket: 'uploads-bucket',
    })

    const result = await service.generatePresignedPut({
      objectKey: 'products/p-1/img.webp',
      contentType: 'image/webp',
      maxBytes: 1024,
    })

    expect(result.maxBytes).toBe(1024)
  })

  it('throws when no upload bucket is configured', async () => {
    const { signer } = makeSpySigner()
    const service = new S3PresignService({ client: fakeClient, signer, bucket: undefined })

    await expect(
      service.generatePresignedPut({ objectKey: 'avatars/u/x.jpg', contentType: 'image/jpeg' }),
    ).rejects.toThrow(/UPLOAD_BUCKET/)
  })
})

describe('S3PresignService.buildPublicUrl', () => {
  it('uses the configured media base URL', () => {
    const service = new S3PresignService({
      client: fakeClient,
      signer: makeSpySigner().signer,
      bucket: 'b',
      mediaBaseUrl: 'https://cdn.example.com',
    })
    expect(service.buildPublicUrl('avatars/u/x.jpg')).toBe(
      'https://cdn.example.com/media/avatars/u/x.jpg',
    )
  })

  it('throws when no media base URL is configured', () => {
    const service = new S3PresignService({
      client: fakeClient,
      signer: makeSpySigner().signer,
      bucket: 'b',
      mediaBaseUrl: undefined,
    })
    expect(() => service.buildPublicUrl('avatars/u/x.jpg')).toThrow(/MEDIA_BASE_URL/)
  })
})
