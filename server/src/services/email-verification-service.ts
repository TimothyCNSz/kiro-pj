// EmailVerificationService（邮箱验证令牌签发/校验/失效，需求 1.4, 1.8–1.11）。
//
// 令牌生命周期（见设计「注册与邮箱验证流程」）：
//   - issue(userId)：生成不可猜测的原始 token，仅持久化其 `tokenHash` 与
//     `expiresAt = now + 24h`（consumedAt/invalidatedAt 为 null），随后经注入的
//     Mailer 外发含原始 token 的验证邮件。返回原始 token 供上层构造链接/验证码。
//   - validate(token, now)：按 tokenHash 查记录；缺失/已消费/已失效 → INVALID；
//     now > expiresAt → EXPIRED；否则置 consumedAt 并返回 { userId }。
//   - invalidateExisting(userId)：将该用户全部「未消费且未失效」的令牌置为失效，
//     使重发后仅保留最新一枚有效令牌（需求 1.11）。
//
// 数据库仅存令牌哈希，明文 token 只随邮件外发，降低库泄露风险（设计「令牌存储」）。
// 依赖以接口形式注入（存储与 Mailer 均可替身），便于属性化测试（任务 3.5/3.6）在
// 无真实数据库/SES 的情况下验证。
//
// Requirements: 1.4, 1.8, 1.9, 1.10, 1.11.

import { createHash, randomBytes } from 'node:crypto'

import { and, eq, isNull } from 'drizzle-orm'

import { db as defaultDb, type Database } from '../db/client'
import { emailVerifications, users } from '../db/schema'

import type { Mailer } from './ses-mailer'

/** 令牌有效期：24 小时（需求 1.8, 1.10）。 */
export const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000

/** 校验失败原因（与设计接口一致）。 */
export type ValidationError = 'EXPIRED' | 'INVALID'

/** `validate` 结果：成功返回 userId，失败返回具体原因。 */
export type ValidationResult = { userId: string } | { error: ValidationError }

/** 存储层视角的一条验证记录（仅暴露服务所需字段）。 */
export interface EmailVerificationRecord {
  userId: string
  tokenHash: string
  expiresAt: Date
  consumedAt: Date | null
  invalidatedAt: Date | null
}

/**
 * 邮箱验证令牌的持久化抽象。默认实现基于 Drizzle（见 `DrizzleEmailVerificationStore`），
 * 测试可注入内存替身以避免真实数据库。
 */
export interface EmailVerificationStore {
  /** 插入一条新令牌记录（consumedAt/invalidatedAt 默认为 null）。 */
  insert(record: { userId: string; tokenHash: string; expiresAt: Date }): Promise<void>
  /** 按 tokenHash 精确查找；不存在返回 null。 */
  findByTokenHash(tokenHash: string): Promise<EmailVerificationRecord | null>
  /** 将指定 tokenHash 的记录标记为已消费。 */
  markConsumed(tokenHash: string, consumedAt: Date): Promise<void>
  /** 将该用户全部「未消费且未失效」的令牌标记为失效。 */
  invalidateUnconsumed(userId: string, invalidatedAt: Date): Promise<void>
}

/** 基于 Drizzle 的默认存储实现。 */
export class DrizzleEmailVerificationStore implements EmailVerificationStore {
  constructor(private readonly db: Database = defaultDb) {}

  async insert(record: { userId: string; tokenHash: string; expiresAt: Date }): Promise<void> {
    await this.db.insert(emailVerifications).values({
      userId: record.userId,
      tokenHash: record.tokenHash,
      expiresAt: record.expiresAt,
    })
  }

  async findByTokenHash(tokenHash: string): Promise<EmailVerificationRecord | null> {
    const rows = await this.db
      .select({
        userId: emailVerifications.userId,
        tokenHash: emailVerifications.tokenHash,
        expiresAt: emailVerifications.expiresAt,
        consumedAt: emailVerifications.consumedAt,
        invalidatedAt: emailVerifications.invalidatedAt,
      })
      .from(emailVerifications)
      .where(eq(emailVerifications.tokenHash, tokenHash))
      .limit(1)

    return rows[0] ?? null
  }

  async markConsumed(tokenHash: string, consumedAt: Date): Promise<void> {
    await this.db
      .update(emailVerifications)
      .set({ consumedAt })
      .where(eq(emailVerifications.tokenHash, tokenHash))
  }

  async invalidateUnconsumed(userId: string, invalidatedAt: Date): Promise<void> {
    await this.db
      .update(emailVerifications)
      .set({ invalidatedAt })
      .where(
        and(
          eq(emailVerifications.userId, userId),
          isNull(emailVerifications.consumedAt),
          isNull(emailVerifications.invalidatedAt),
        ),
      )
  }
}

/** `EmailVerificationService` 构造选项。 */
export interface EmailVerificationServiceOptions {
  /** 令牌持久化实现（缺省 Drizzle）。 */
  store?: EmailVerificationStore
  /** 发信实现（issue 时发送验证邮件；必填以保证可测试注入）。 */
  mailer: Mailer
  /** 生成不可猜测的原始 token（缺省 32 字节随机 base64url）。 */
  generateToken?: () => string
  /** 由原始 token 计算存储哈希（缺省 sha256 十六进制）。 */
  hashToken?: (token: string) => string
  /** 时钟（缺省 `() => new Date()`），便于测试控制 issue 的过期时间。 */
  now?: () => Date
  /**
   * 验证链接基址（形如 `https://<domain>/verify`）。提供时邮件正文含
   * `?token=<token>` 链接；缺省则以验证码形式在正文给出原始 token。
   */
  verifyUrlBase?: string
  /**
   * 由 userId 解析收件邮箱地址（issue 发信用）。缺省经 Drizzle 查 users.email。
   * 测试可注入替身以避免真实数据库。
   */
  resolveRecipient?: (userId: string) => Promise<string>
}

/** 生成 32 字节的不可猜测随机 token（URL 安全）。 */
const defaultGenerateToken = (): string => randomBytes(32).toString('base64url')

/** sha256(token) 的十六进制串（64 字符，契合 schema varchar(128)）。 */
const defaultHashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex')

/** 默认收件人解析：经 Drizzle 按 userId 查 users.email。 */
const makeDefaultResolveRecipient =
  (database: Database) =>
  async (userId: string): Promise<string> => {
    const rows = await database
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    const email = rows[0]?.email
    if (!email) {
      throw new Error(`Cannot send verification email: user ${userId} has no email.`)
    }
    return email
  }

/**
 * 邮箱验证令牌服务：签发、校验、失效。
 *
 * 仅存令牌哈希；明文 token 只随邮件外发。所有外部依赖（存储、发信、时钟、
 * token 生成/哈希）均可注入，便于测试。
 */
export class EmailVerificationService {
  private readonly store: EmailVerificationStore
  private readonly mailer: Mailer
  private readonly generateToken: () => string
  private readonly hashToken: (token: string) => string
  private readonly now: () => Date
  private readonly verifyUrlBase?: string
  private readonly resolveRecipient: (userId: string) => Promise<string>

  constructor(options: EmailVerificationServiceOptions) {
    this.store = options.store ?? new DrizzleEmailVerificationStore()
    this.mailer = options.mailer
    this.generateToken = options.generateToken ?? defaultGenerateToken
    this.hashToken = options.hashToken ?? defaultHashToken
    this.now = options.now ?? (() => new Date())
    this.verifyUrlBase = options.verifyUrlBase
    this.resolveRecipient = options.resolveRecipient ?? makeDefaultResolveRecipient(defaultDb)
  }

  /**
   * 为用户签发新验证令牌：生成不可猜测 token，仅持久化 tokenHash 与
   * expiresAt = now + 24h，随后经 Mailer 发送验证邮件。返回原始 token。
   *
   * 注意：本方法不负责失效旧令牌；重发场景应先调用 `invalidateExisting`。
   */
  async issue(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = this.generateToken()
    const tokenHash = this.hashToken(token)
    const expiresAt = new Date(this.now().getTime() + VERIFICATION_TTL_MS)

    await this.store.insert({ userId, tokenHash, expiresAt })
    await this.sendVerificationEmail(userId, token)

    return { token, expiresAt }
  }

  /**
   * 校验原始 token：
   *   - 记录不存在 / 已消费 / 已失效 → { error: 'INVALID' }
   *   - now > expiresAt → { error: 'EXPIRED' }
   *   - 否则置 consumedAt 并返回 { userId }
   */
  async validate(token: string, now: Date): Promise<ValidationResult> {
    const tokenHash = this.hashToken(token)
    const record = await this.store.findByTokenHash(tokenHash)

    if (!record || record.consumedAt !== null || record.invalidatedAt !== null) {
      return { error: 'INVALID' }
    }
    if (now.getTime() > record.expiresAt.getTime()) {
      return { error: 'EXPIRED' }
    }

    await this.store.markConsumed(tokenHash, now)
    return { userId: record.userId }
  }

  /**
   * 使该用户此前全部「未消费且未失效」的令牌失效（重发前调用），
   * 从而重发后仅保留最新一枚有效令牌（需求 1.11）。
   */
  async invalidateExisting(userId: string): Promise<void> {
    await this.store.invalidateUnconsumed(userId, this.now())
  }

  /** 构造并发送验证邮件（含链接或验证码）。 */
  private async sendVerificationEmail(userId: string, token: string): Promise<void> {
    const link = this.verifyUrlBase
      ? `${this.verifyUrlBase}?token=${encodeURIComponent(token)}`
      : undefined

    const to = await this.resolveRecipient(userId)

    const subject = 'AWSomeShop 邮箱验证 / メールアドレスの確認'
    const text = link
      ? `请点击以下链接完成邮箱验证（24 小时内有效）：\n${link}\n\n次のリンクからメールアドレスを確認してください（24時間有効）。`
      : `您的验证码（24 小时内有效）：${token}\n\n確認コード（24時間有効）：${token}`
    const html = link
      ? `<p>请点击以下链接完成邮箱验证（24 小时内有效）：</p><p><a href="${link}">${link}</a></p>`
      : `<p>您的验证码（24 小时内有效）：<strong>${token}</strong></p>`

    await this.mailer.send({ to, subject, text, html })
  }
}
