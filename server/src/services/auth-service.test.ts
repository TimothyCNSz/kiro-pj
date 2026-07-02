// Unit tests for AuthService (注册/登录/登出, 需求 1.3–1.6, 1.12–1.14, 1.5, 2.5)。
//
// 依赖全部以内存替身注入，不触达真实数据库 / SES / AWS。

import { describe, expect, it, vi } from 'vitest'

import { AccountStatus, Role } from '../lib/domain'
import { ERROR_DEFINITIONS, ErrorCode } from '../lib/errors'
import { resolveErrorCode } from '../middleware/http-error'

import {
  AuthService,
  EMAIL_NOT_VERIFIED_MESSAGE,
  INVALID_CREDENTIALS_MESSAGE,
  ValidationError,
  type AuthStore,
  type AuthUserRecord,
  type TokenSigner,
} from './auth-service'
import type { SessionService } from './session-service'

const COMPANY_DOMAINS = ['company.com']

/** 简单内存用户存储替身。 */
class FakeAuthStore implements AuthStore {
  users = new Map<string, AuthUserRecord>()
  private seq = 0
  createCalls = 0

  async findByEmail(email: string): Promise<AuthUserRecord | null> {
    return this.users.get(email) ?? null
  }

  async createEmployeeWithPointsAccount(input: {
    email: string
    passwordHash: string
  }): Promise<{ userId: string }> {
    this.createCalls += 1
    const userId = `user-${(this.seq += 1)}`
    this.users.set(input.email, {
      id: userId,
      passwordHash: input.passwordHash,
      role: Role.Employee,
      status: AccountStatus.PendingVerification,
    })
    return { userId }
  }
}

class FakeSessionService implements SessionService {
  created: string[] = []
  revoked: string[] = []
  private seq = 0

  async create(userId: string) {
    this.created.push(userId)
    return { sessionId: `session-${(this.seq += 1)}`, expiresAt: new Date() }
  }

  async revoke(sessionId: string) {
    this.revoked.push(sessionId)
  }
}

const fakeSigner: TokenSigner = {
  sign: (payload) => `token:${payload.sub}:${payload.sid}:${payload.role}`,
}

/** 便捷：使用可选覆盖构造 AuthService 及其替身。 */
function makeService(overrides?: {
  issue?: (userId: string) => Promise<{ token: string; expiresAt: Date }>
  hashPassword?: (p: string) => string
  verifyPassword?: (p: string, s: string) => boolean
}) {
  const store = new FakeAuthStore()
  const sessionService = new FakeSessionService()
  const issue =
    overrides?.issue ?? vi.fn(async () => ({ token: 't', expiresAt: new Date() }))
  const service = new AuthService({
    store,
    emailVerificationService: { issue },
    sessionService,
    tokenSigner: fakeSigner,
    companyEmailDomains: COMPANY_DOMAINS,
    // 用可逆的假哈希以加速测试并保持确定性。
    hashPassword: overrides?.hashPassword ?? ((p: string) => `hash(${p})`),
    verifyPassword:
      overrides?.verifyPassword ?? ((p: string, s: string) => s === `hash(${p})`),
  })
  return { service, store, sessionService, issue }
}

describe('AuthService.register', () => {
  it('creates a pending_verification employee + points account and issues verification email (1.3, 1.4)', async () => {
    const { service, store, issue } = makeService()
    const result = await service.register('New.User@Company.com', 'Password1')

    expect(result.status).toBe(AccountStatus.PendingVerification)
    expect(result.emailSendFailed).toBe(false)
    expect(store.createCalls).toBe(1)
    // 邮箱规范化为小写存储。
    const stored = store.users.get('new.user@company.com')
    expect(stored).toBeTruthy()
    expect(stored?.role).toBe(Role.Employee)
    expect(stored?.status).toBe(AccountStatus.PendingVerification)
    expect(issue).toHaveBeenCalledWith(result.userId)
  })

  it('rejects a duplicate email with EMAIL_TAKEN (1.5)', async () => {
    const { service } = makeService()
    await service.register('dup@company.com', 'Password1')
    await expect(service.register('dup@company.com', 'Password1')).rejects.toMatchObject({
      errorCode: ErrorCode.EmailTaken,
    })
  })

  it('rejects a weak password with itemized VALIDATION field errors (1.1, 1.6)', async () => {
    const { service, store } = makeService()
    await expect(service.register('ok@company.com', 'short')).rejects.toBeInstanceOf(
      ValidationError,
    )
    try {
      await service.register('ok@company.com', 'short')
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError)
      expect((err as ValidationError).fieldErrors.password).toBe('WEAK_PASSWORD')
      expect(resolveErrorCode(err)).toBe(ErrorCode.Validation)
    }
    // 校验失败时不得创建账号。
    expect(store.createCalls).toBe(0)
  })

  it('rejects a non-company domain with a COMPANY_DOMAIN_REQUIRED field error (1.7)', async () => {
    const { service } = makeService()
    try {
      await service.register('user@gmail.com', 'Password1')
      throw new Error('expected rejection')
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError)
      expect((err as ValidationError).fieldErrors.email).toBe('COMPANY_DOMAIN_REQUIRED')
    }
  })

  it('rejects a malformed email with an INVALID_EMAIL_FORMAT field error (1.6)', async () => {
    const { service } = makeService()
    try {
      await service.register('not-an-email', 'Password1')
      throw new Error('expected rejection')
    } catch (err) {
      expect((err as ValidationError).fieldErrors.email).toBe('INVALID_EMAIL_FORMAT')
    }
  })

  it('does NOT roll back the account when email sending fails; surfaces emailSendFailed=true (1.4)', async () => {
    const { service, store } = makeService({
      issue: vi.fn(async () => {
        throw new Error('SES down')
      }),
    })
    const result = await service.register('flaky@company.com', 'Password1')
    expect(result.emailSendFailed).toBe(true)
    expect(result.status).toBe(AccountStatus.PendingVerification)
    // 账号仍被创建（不回滚）。
    expect(store.users.get('flaky@company.com')).toBeTruthy()
  })
})

describe('AuthService.login', () => {
  async function seedActiveUser(store: FakeAuthStore, email: string, password: string) {
    store.users.set(email, {
      id: 'active-1',
      passwordHash: `hash(${password})`,
      role: Role.Employee,
      status: AccountStatus.Active,
    })
  }

  it('logs in an active user: creates a session and returns token + role (1.12, 2.1)', async () => {
    const { service, store, sessionService } = makeService()
    await seedActiveUser(store, 'active@company.com', 'Password1')

    const result = await service.login('Active@Company.com', 'Password1')
    expect(result.role).toBe(Role.Employee)
    expect(result.token).toBe('token:active-1:session-1:employee')
    expect(sessionService.created).toEqual(['active-1'])
  })

  it('rejects a wrong password with the indistinguishable credentials error (1.14)', async () => {
    const { service, store } = makeService()
    await seedActiveUser(store, 'active@company.com', 'Password1')

    try {
      await service.login('active@company.com', 'WrongPass9')
      throw new Error('expected rejection')
    } catch (err) {
      expect(resolveErrorCode(err)).toBe(ErrorCode.Unauthenticated)
      expect((err as Error).message).toBe(INVALID_CREDENTIALS_MESSAGE)
    }
  })

  it('rejects an unknown email with the SAME error code and message as a wrong password (1.14)', async () => {
    const { service, store } = makeService()
    await seedActiveUser(store, 'active@company.com', 'Password1')

    let unknownErr: unknown
    let wrongPwErr: unknown
    try {
      await service.login('nobody@company.com', 'Password1')
    } catch (e) {
      unknownErr = e
    }
    try {
      await service.login('active@company.com', 'nope99999')
    } catch (e) {
      wrongPwErr = e
    }
    expect(resolveErrorCode(unknownErr)).toBe(resolveErrorCode(wrongPwErr))
    expect((unknownErr as Error).message).toBe((wrongPwErr as Error).message)
    expect((unknownErr as Error).message).toBe(INVALID_CREDENTIALS_MESSAGE)
  })

  it('rejects a pending_verification account (correct credentials) with EMAIL_NOT_VERIFIED (1.13)', async () => {
    const { service, store } = makeService()
    store.users.set('pending@company.com', {
      id: 'pending-1',
      passwordHash: 'hash(Password1)',
      role: Role.Employee,
      status: AccountStatus.PendingVerification,
    })

    try {
      await service.login('pending@company.com', 'Password1')
      throw new Error('expected rejection')
    } catch (err) {
      expect(resolveErrorCode(err)).toBe(ErrorCode.EmailNotVerified)
      expect((err as Error).message).toBe(EMAIL_NOT_VERIFIED_MESSAGE)
    }
  })

  it('does not establish a session on failed login', async () => {
    const { service, store, sessionService } = makeService()
    await seedActiveUser(store, 'active@company.com', 'Password1')
    await expect(service.login('active@company.com', 'bad')).rejects.toBeTruthy()
    expect(sessionService.created).toEqual([])
  })
})

describe('AuthService.logout', () => {
  it('revokes the current session (2.5)', async () => {
    const { service, sessionService } = makeService()
    await service.logout('session-xyz')
    expect(sessionService.revoked).toEqual(['session-xyz'])
  })
})

describe('error registry wiring', () => {
  it('maps the credentials error code to HTTP 401', () => {
    expect(ERROR_DEFINITIONS[ErrorCode.Unauthenticated].httpStatus).toBe(401)
  })
})
