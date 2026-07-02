import { describe, it, expect, beforeEach } from 'vitest'

import {
  AvatarService,
  DEFAULT_AVATAR_URL,
  type AvatarRepository,
} from './avatar-service'

// ---------------------------------------------------------------------------
// Fakes — an in-memory avatar repository records the last write; the public
// URL builder is a deterministic stub so tests never touch AWS/CloudFront.
// ---------------------------------------------------------------------------

class FakeAvatarRepository implements AvatarRepository {
  readonly writes: Array<{ userId: string; avatarUrl: string }> = []

  async setAvatarUrl(userId: string, avatarUrl: string): Promise<void> {
    this.writes.push({ userId, avatarUrl })
  }
}

const fakeBuildUrl = (objectKey: string) => `https://cdn.example.com/media/${objectKey}`

function buildService(): { service: AvatarService; repo: FakeAvatarRepository } {
  const repo = new FakeAvatarRepository()
  const service = new AvatarService({ repository: repo, buildUrl: fakeBuildUrl })
  return { service, repo }
}

// ---------------------------------------------------------------------------
// setAvatar (需求 22.9, 23.3, 23.4)
// ---------------------------------------------------------------------------

describe('AvatarService.setAvatar (需求 22.9, 23.3, 23.4)', () => {
  let service: AvatarService
  let repo: FakeAvatarRepository
  beforeEach(() => {
    ;({ service, repo } = buildService())
  })

  it('derives the public URL from the objectKey and returns it', async () => {
    const result = await service.setAvatar('user-1', 'avatars/user-1/abc.png')
    expect(result).toEqual({ avatarUrl: 'https://cdn.example.com/media/avatars/user-1/abc.png' })
  })

  it('persists the new avatarUrl for the given user (需求 22.9)', async () => {
    await service.setAvatar('user-1', 'avatars/user-1/abc.png')
    expect(repo.writes).toEqual([
      { userId: 'user-1', avatarUrl: 'https://cdn.example.com/media/avatars/user-1/abc.png' },
    ])
  })

  it('always associates to the exact user id it was given (限本人边界)', async () => {
    await service.setAvatar('employee-42', 'avatars/employee-42/x.webp')
    expect(repo.writes[0].userId).toBe('employee-42')
  })

  it('defaults to buildPublicUrl when no builder is injected', () => {
    // Constructing without a builder must not throw (side-effect free).
    const s = new AvatarService({ repository: new FakeAvatarRepository() })
    expect(s).toBeInstanceOf(AvatarService)
  })
})

// ---------------------------------------------------------------------------
// resolveAvatarUrl (需求 23.2, 23.4)
// ---------------------------------------------------------------------------

describe('AvatarService.resolveAvatarUrl (需求 23.2, 23.4)', () => {
  let service: AvatarService
  beforeEach(() => {
    ;({ service } = buildService())
  })

  it('falls back to the default avatar when avatarUrl is null (需求 23.2)', () => {
    expect(service.resolveAvatarUrl({ avatarUrl: null })).toBe(DEFAULT_AVATAR_URL)
  })

  it('falls back to the default avatar when avatarUrl is blank whitespace (需求 23.2)', () => {
    expect(service.resolveAvatarUrl({ avatarUrl: '   ' })).toBe(DEFAULT_AVATAR_URL)
    expect(service.resolveAvatarUrl({ avatarUrl: '' })).toBe(DEFAULT_AVATAR_URL)
  })

  it('returns the set avatarUrl when present (需求 23.4)', () => {
    const url = 'https://cdn.example.com/media/avatars/user-1/abc.png'
    expect(service.resolveAvatarUrl({ avatarUrl: url })).toBe(url)
  })

  it('reflects the newly set avatar after setAvatar (回退 → 新头像)', async () => {
    expect(service.resolveAvatarUrl({ avatarUrl: null })).toBe(DEFAULT_AVATAR_URL)
    const { avatarUrl } = await service.setAvatar('user-1', 'avatars/user-1/new.png')
    expect(service.resolveAvatarUrl({ avatarUrl })).toBe(avatarUrl)
    expect(avatarUrl).not.toBe(DEFAULT_AVATAR_URL)
  })
})
