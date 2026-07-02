import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  DEFAULT_SESSION_IDLE_MINUTES,
  DrizzleSessionService,
  getSessionIdleMinutes,
  isSessionValid,
  type SessionRecord,
  type SessionStore,
} from './session-service'

// ---------------------------------------------------------------------------
// In-memory SessionStore test double (no real database).
// ---------------------------------------------------------------------------

class InMemorySessionStore implements SessionStore {
  private rows = new Map<string, SessionRecord>()
  private seq = 0

  async insert(record: {
    userId: string
    lastActiveAt: Date
    expiresAt: Date
  }): Promise<SessionRecord> {
    const id = `session-${++this.seq}`
    const row: SessionRecord = {
      id,
      userId: record.userId,
      lastActiveAt: record.lastActiveAt,
      expiresAt: record.expiresAt,
      revokedAt: null,
    }
    this.rows.set(id, row)
    return { ...row }
  }

  async findById(sessionId: string): Promise<SessionRecord | null> {
    const row = this.rows.get(sessionId)
    return row ? { ...row } : null
  }

  async updateActivity(
    sessionId: string,
    lastActiveAt: Date,
    expiresAt: Date,
  ): Promise<SessionRecord | null> {
    const row = this.rows.get(sessionId)
    if (!row || row.revokedAt !== null) return null
    row.lastActiveAt = lastActiveAt
    row.expiresAt = expiresAt
    return { ...row }
  }

  async revoke(sessionId: string, revokedAt: Date): Promise<void> {
    const row = this.rows.get(sessionId)
    if (row) row.revokedAt = revokedAt
  }
}

const MINUTE = 60_000

describe('isSessionValid (pure predicate, 需求 2.2, 2.3, 2.5)', () => {
  const now = new Date('2024-01-01T00:00:00.000Z')

  it('valid while not revoked and now <= expiresAt', () => {
    const session = { expiresAt: new Date(now.getTime() + MINUTE), revokedAt: null }
    expect(isSessionValid(session, now)).toBe(true)
  })

  it('valid exactly at the expiry boundary (now == expiresAt)', () => {
    const session = { expiresAt: new Date(now.getTime()), revokedAt: null }
    expect(isSessionValid(session, now)).toBe(true)
  })

  it('invalid when idle-expired (now > expiresAt)', () => {
    const session = { expiresAt: new Date(now.getTime() - 1), revokedAt: null }
    expect(isSessionValid(session, now)).toBe(false)
  })

  it('invalid when revoked, even if not yet idle-expired', () => {
    const session = {
      expiresAt: new Date(now.getTime() + MINUTE),
      revokedAt: new Date(now.getTime() - MINUTE),
    }
    expect(isSessionValid(session, now)).toBe(false)
  })

  it('treats undefined revokedAt as not revoked', () => {
    const session = { expiresAt: new Date(now.getTime() + MINUTE), revokedAt: undefined }
    expect(isSessionValid(session, now)).toBe(true)
  })
})

describe('getSessionIdleMinutes', () => {
  const prev = process.env.SESSION_IDLE_MINUTES

  afterEach(() => {
    if (prev === undefined) delete process.env.SESSION_IDLE_MINUTES
    else process.env.SESSION_IDLE_MINUTES = prev
  })

  it('reads a positive value from the env var', () => {
    process.env.SESSION_IDLE_MINUTES = '30'
    expect(getSessionIdleMinutes()).toBe(30)
  })

  it('falls back to the default for missing/invalid/non-positive values', () => {
    delete process.env.SESSION_IDLE_MINUTES
    expect(getSessionIdleMinutes()).toBe(DEFAULT_SESSION_IDLE_MINUTES)
    process.env.SESSION_IDLE_MINUTES = 'not-a-number'
    expect(getSessionIdleMinutes()).toBe(DEFAULT_SESSION_IDLE_MINUTES)
    process.env.SESSION_IDLE_MINUTES = '0'
    expect(getSessionIdleMinutes()).toBe(DEFAULT_SESSION_IDLE_MINUTES)
  })
})

describe('DrizzleSessionService (with in-memory store + injected clock)', () => {
  let store: InMemorySessionStore
  let clock: Date
  let service: DrizzleSessionService

  beforeEach(() => {
    store = new InMemorySessionStore()
    clock = new Date('2024-01-01T00:00:00.000Z')
    service = new DrizzleSessionService({ store, idleMinutes: 60, now: () => clock })
  })

  it('create establishes a 60-min idle session (需求 2.1)', async () => {
    const created = await service.create('user-1')
    expect(created.sessionId).toBeTruthy()
    expect(created.expiresAt.getTime()).toBe(clock.getTime() + 60 * MINUTE)

    const stored = await store.findById(created.sessionId)
    expect(stored).not.toBeNull()
    expect(stored!.userId).toBe('user-1')
    expect(stored!.lastActiveAt.getTime()).toBe(clock.getTime())
    expect(stored!.revokedAt).toBeNull()
    expect(isSessionValid(stored!, clock)).toBe(true)
  })

  it('refresh extends lastActiveAt and expiresAt on valid access (需求 2.2)', async () => {
    const created = await service.create('user-1')
    // 30 minutes of idle time pass — still within the window.
    clock = new Date(clock.getTime() + 30 * MINUTE)
    const refreshed = await service.refresh(created.sessionId)
    expect(refreshed).not.toBeNull()
    expect(refreshed!.lastActiveAt.getTime()).toBe(clock.getTime())
    expect(refreshed!.expiresAt.getTime()).toBe(clock.getTime() + 60 * MINUTE)
  })

  it('touch is an alias for refresh', async () => {
    const created = await service.create('user-1')
    clock = new Date(clock.getTime() + 10 * MINUTE)
    const touched = await service.touch(created.sessionId)
    expect(touched!.expiresAt.getTime()).toBe(clock.getTime() + 60 * MINUTE)
  })

  it('revoke immediately terminates the session (需求 2.5)', async () => {
    const created = await service.create('user-1')
    await service.revoke(created.sessionId)
    const fetched = await store.findById(created.sessionId)
    expect(fetched!.revokedAt).not.toBeNull()
    expect(isSessionValid(fetched!, clock)).toBe(false)
  })

  it('validateAndTouch refreshes a valid session', async () => {
    const created = await service.create('user-1')
    clock = new Date(clock.getTime() + 20 * MINUTE)
    const result = await service.validateAndTouch(created.sessionId)
    expect(result).not.toBeNull()
    expect(result!.expiresAt.getTime()).toBe(clock.getTime() + 60 * MINUTE)
  })

  it('validateAndTouch rejects an idle-expired session (需求 2.3)', async () => {
    const created = await service.create('user-1')
    // Advance beyond the 60-min idle window.
    clock = new Date(clock.getTime() + 61 * MINUTE)
    const result = await service.validateAndTouch(created.sessionId)
    expect(result).toBeNull()
  })

  it('validateAndTouch rejects a revoked session and refresh does not revive it', async () => {
    const created = await service.create('user-1')
    await service.revoke(created.sessionId)
    expect(await service.validateAndTouch(created.sessionId)).toBeNull()
    // refresh must not resurrect a revoked session either.
    expect(await service.refresh(created.sessionId)).toBeNull()
  })

  it('validateAndTouch returns null for an unknown session id', async () => {
    expect(await service.validateAndTouch('does-not-exist')).toBeNull()
  })
})
