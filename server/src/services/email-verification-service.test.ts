import { describe, expect, it } from 'vitest'

import {
  EmailVerificationService,
  VERIFICATION_TTL_MS,
  type EmailVerificationRecord,
  type EmailVerificationStore,
} from './email-verification-service'
import type { EmailMessage, Mailer } from './ses-mailer'

// ---------------------------------------------------------------------------
// Test doubles: in-memory store + spy mailer (no real DB / SES).
// ---------------------------------------------------------------------------

class InMemoryStore implements EmailVerificationStore {
  rows: EmailVerificationRecord[] = []

  async insert(record: { userId: string; tokenHash: string; expiresAt: Date }): Promise<void> {
    this.rows.push({
      userId: record.userId,
      tokenHash: record.tokenHash,
      expiresAt: record.expiresAt,
      consumedAt: null,
      invalidatedAt: null,
    })
  }

  async findByTokenHash(tokenHash: string): Promise<EmailVerificationRecord | null> {
    return this.rows.find((r) => r.tokenHash === tokenHash) ?? null
  }

  async markConsumed(tokenHash: string, consumedAt: Date): Promise<void> {
    for (const r of this.rows) {
      if (r.tokenHash === tokenHash) r.consumedAt = consumedAt
    }
  }

  async invalidateUnconsumed(userId: string, invalidatedAt: Date): Promise<void> {
    for (const r of this.rows) {
      if (r.userId === userId && r.consumedAt === null && r.invalidatedAt === null) {
        r.invalidatedAt = invalidatedAt
      }
    }
  }
}

class SpyMailer implements Mailer {
  sent: EmailMessage[] = []
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message)
  }
}

const makeService = (overrides: {
  store?: InMemoryStore
  mailer?: SpyMailer
  now?: () => Date
  tokens?: string[]
  verifyUrlBase?: string
}) => {
  const store = overrides.store ?? new InMemoryStore()
  const mailer = overrides.mailer ?? new SpyMailer()
  const tokens = overrides.tokens ? [...overrides.tokens] : undefined
  const service = new EmailVerificationService({
    store,
    mailer,
    now: overrides.now,
    verifyUrlBase: overrides.verifyUrlBase,
    generateToken: tokens ? () => tokens.shift() ?? 'exhausted' : undefined,
    resolveRecipient: async (userId) => `${userId}@example.com`,
  })
  return { service, store, mailer }
}

describe('EmailVerificationService.issue', () => {
  it('stores only the token hash plus expiresAt = now + 24h with null consumed/invalidated', async () => {
    const now = new Date('2024-01-01T00:00:00.000Z')
    const { service, store } = makeService({ now: () => now, tokens: ['plain-token'] })

    const result = await service.issue('user-1')

    expect(result.token).toBe('plain-token')
    expect(store.rows).toHaveLength(1)
    const row = store.rows[0]
    // Only the hash is persisted, never the plaintext token.
    expect(row.tokenHash).not.toBe('plain-token')
    expect(row.tokenHash.length).toBeGreaterThan(0)
    expect(row.expiresAt.getTime()).toBe(now.getTime() + VERIFICATION_TTL_MS)
    expect(result.expiresAt.getTime()).toBe(now.getTime() + VERIFICATION_TTL_MS)
    expect(row.consumedAt).toBeNull()
    expect(row.invalidatedAt).toBeNull()
  })

  it('sends a verification email to the resolved recipient', async () => {
    const { service, mailer } = makeService({ verifyUrlBase: 'https://shop.example/verify' })

    const { token } = await service.issue('user-42')

    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0].to).toBe('user-42@example.com')
    expect(mailer.sent[0].text).toContain(encodeURIComponent(token))
  })

  it('generates unguessable, distinct tokens by default', async () => {
    const { service } = makeService({})
    const a = await service.issue('u')
    const b = await service.issue('u')
    expect(a.token).not.toBe(b.token)
    expect(a.token.length).toBeGreaterThanOrEqual(32)
  })
})

describe('EmailVerificationService.validate', () => {
  it('returns userId and marks consumed on success', async () => {
    const now = new Date('2024-01-01T00:00:00.000Z')
    const { service, store } = makeService({ now: () => now, tokens: ['tok'] })
    await service.issue('user-1')

    const result = await service.validate('tok', new Date(now.getTime() + 1000))

    expect(result).toEqual({ userId: 'user-1' })
    expect(store.rows[0].consumedAt).not.toBeNull()
  })

  it('accepts validation exactly at expiry boundary (now == expiresAt)', async () => {
    const now = new Date('2024-01-01T00:00:00.000Z')
    const { service } = makeService({ now: () => now, tokens: ['tok'] })
    const { expiresAt } = await service.issue('user-1')

    const result = await service.validate('tok', expiresAt)
    expect(result).toEqual({ userId: 'user-1' })
  })

  it('returns EXPIRED when now > expiresAt', async () => {
    const now = new Date('2024-01-01T00:00:00.000Z')
    const { service } = makeService({ now: () => now, tokens: ['tok'] })
    const { expiresAt } = await service.issue('user-1')

    const result = await service.validate('tok', new Date(expiresAt.getTime() + 1))
    expect(result).toEqual({ error: 'EXPIRED' })
  })

  it('returns INVALID for an unknown token', async () => {
    const { service } = makeService({})
    const result = await service.validate('nope', new Date())
    expect(result).toEqual({ error: 'INVALID' })
  })

  it('returns INVALID for an already-consumed token', async () => {
    const now = new Date('2024-01-01T00:00:00.000Z')
    const { service } = makeService({ now: () => now, tokens: ['tok'] })
    await service.issue('user-1')
    await service.validate('tok', new Date(now.getTime() + 1000))

    const again = await service.validate('tok', new Date(now.getTime() + 2000))
    expect(again).toEqual({ error: 'INVALID' })
  })

  it('returns INVALID for an invalidated token', async () => {
    const now = new Date('2024-01-01T00:00:00.000Z')
    const { service } = makeService({ now: () => now, tokens: ['tok'] })
    await service.issue('user-1')
    await service.invalidateExisting('user-1')

    const result = await service.validate('tok', new Date(now.getTime() + 1000))
    expect(result).toEqual({ error: 'INVALID' })
  })
})

describe('EmailVerificationService.invalidateExisting', () => {
  it('invalidates only unconsumed, not-yet-invalidated tokens for the user', async () => {
    const now = new Date('2024-01-01T00:00:00.000Z')
    const store = new InMemoryStore()
    const { service } = makeService({ store, now: () => now, tokens: ['t1', 't2', 't3'] })

    await service.issue('user-1') // t1
    await service.validate('t1', new Date(now.getTime() + 1000)) // consume t1
    await service.issue('user-1') // t2 (active)
    await service.issue('user-2') // t3 (other user)

    await service.invalidateExisting('user-1')

    const byToken = (userId: string, consumed: boolean) =>
      store.rows.find((r) => r.userId === userId && (r.consumedAt !== null) === consumed)

    // Consumed t1 stays consumed, not invalidated.
    expect(byToken('user-1', true)?.invalidatedAt).toBeNull()
    // Active t2 for user-1 becomes invalidated.
    expect(byToken('user-1', false)?.invalidatedAt).not.toBeNull()
    // Other user's token is untouched.
    expect(store.rows.find((r) => r.userId === 'user-2')?.invalidatedAt).toBeNull()
  })

  it('leaves at most one valid token after resend (invalidate + issue)', async () => {
    const now = new Date('2024-01-01T00:00:00.000Z')
    const store = new InMemoryStore()
    const { service } = makeService({ store, now: () => now, tokens: ['old', 'new'] })

    await service.issue('user-1')
    // Resend: invalidate old, issue new.
    await service.invalidateExisting('user-1')
    await service.issue('user-1')

    const valid = store.rows.filter(
      (r) => r.consumedAt === null && r.invalidatedAt === null,
    )
    expect(valid).toHaveLength(1)

    // Old token no longer validates; new one does.
    expect(await service.validate('old', new Date(now.getTime() + 1000))).toEqual({
      error: 'INVALID',
    })
    expect(await service.validate('new', new Date(now.getTime() + 1000))).toEqual({
      userId: 'user-1',
    })
  })
})
