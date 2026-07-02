// SessionService — 会话空闲过期管理（需求 2.1, 2.2, 2.3, 2.5）。
//
// 会话空闲过期在服务端权威判定（见设计「认证与会话流程（需求 1、2）」）：
//   - 会话在 RDS 的 `sessions` 表中维护 `lastActiveAt`、`expiresAt` 与 `revokedAt`。
//   - `expiresAt = lastActiveAt + 空闲窗口`（默认 60min，来自 `SESSION_IDLE_MINUTES`）。
//   - 每次受保护请求：若会话有效（未撤销且未空闲过期）则刷新 `lastActiveAt`
//     （顺延 `expiresAt`，需求 2.2）；否则拒绝（上层返回 401，需求 2.4）。
//   - 登出时置 `revokedAt` 立即终止会话（需求 2.5）。
//
// 无状态 Lambda 说明：会话有效性判定完全依赖 RDS 中的 `Session` 行，与执行环境/
// 冷启动无关（空闲过期是「数据」而非「进程内存」）。
//
// 本文件保留 AuthService（任务 3.7）依赖的最小接缝——`SessionService` 接口
// （`create`/`revoke`）、`CreatedSession`、`DrizzleSessionService`——并在其上补齐
// 任务 3.11 的空闲校验与活跃刷新：纯谓词 `isSessionValid` 单独导出（供属性测试
// 任务 3.12），刷新/校验方法置于更丰富的 `SessionManager` 接口与具体实现上，
// 避免破坏仅依赖最小接缝的 AuthService。存储以 `SessionStore` 抽象注入，便于在
// 无真实数据库下测试。
//
// Requirements: 2.1, 2.2, 2.3, 2.5.

import { and, eq, isNull } from 'drizzle-orm'

import { db as defaultDb, type Database } from '../db/client'
import { sessions } from '../db/schema'

/** 默认会话空闲过期时长（分钟，需求 2.1, 2.3）。 */
export const DEFAULT_SESSION_IDLE_MINUTES = 60

const MS_PER_MINUTE = 60_000

/**
 * 从环境变量 `SESSION_IDLE_MINUTES` 解析空闲过期时长（分钟），
 * 非法或缺省时回退到 {@link DEFAULT_SESSION_IDLE_MINUTES}。
 */
export function getSessionIdleMinutes(): number {
  const raw = process.env.SESSION_IDLE_MINUTES
  const parsed = raw !== undefined ? Number(raw) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_IDLE_MINUTES
}

// ---------------------------------------------------------------------------
// Pure validity predicate (需求 2.2, 2.3, 2.5)
// ---------------------------------------------------------------------------

/** 判定会话有效性所需的最小视图（`isSessionValid` 只依赖这两个字段）。 */
export interface SessionValidityView {
  /** 空闲过期时刻（= lastActiveAt + 空闲窗口）。 */
  expiresAt: Date
  /** 撤销时刻；null/undefined 表示未撤销。 */
  revokedAt: Date | null | undefined
}

/**
 * 纯谓词：会话在 `now` 时刻是否有效（需求 2.2, 2.3, 2.5）。
 *
 * 有效当且仅当：`revokedAt` 为空（未登出/未撤销）且 `now <= expiresAt`
 * （未空闲过期）。无任何副作用，便于属性化测试（任务 3.12）。
 *
 * @param session 会话有效性视图（`expiresAt` 与 `revokedAt`）。
 * @param now 判定所用的当前时刻。
 * @returns 有效返回 `true`，撤销或空闲过期返回 `false`。
 */
export function isSessionValid(session: SessionValidityView, now: Date): boolean {
  if (session.revokedAt != null) return false
  return now.getTime() <= session.expiresAt.getTime()
}

// ---------------------------------------------------------------------------
// Persistence abstraction
// ---------------------------------------------------------------------------

/** 存储层视角的一条会话记录。 */
export interface SessionRecord {
  id: string
  userId: string
  lastActiveAt: Date
  expiresAt: Date
  revokedAt: Date | null
}

/**
 * 会话持久化抽象。默认实现基于 Drizzle（见 `DrizzleSessionStore`），
 * 测试可注入内存替身以避免真实数据库。
 */
export interface SessionStore {
  /** 插入一条新会话（revokedAt 默认为 null），返回创建后的记录。 */
  insert(record: { userId: string; lastActiveAt: Date; expiresAt: Date }): Promise<SessionRecord>
  /** 按 id 精确查找；不存在返回 null。 */
  findById(sessionId: string): Promise<SessionRecord | null>
  /**
   * 刷新一条「未撤销」会话的活跃时间与过期时间；返回更新后的记录。
   * 若会话不存在或已撤销则返回 null（不复活已撤销会话）。
   */
  updateActivity(
    sessionId: string,
    lastActiveAt: Date,
    expiresAt: Date,
  ): Promise<SessionRecord | null>
  /** 将指定会话标记为已撤销（登出，需求 2.5）。 */
  revoke(sessionId: string, revokedAt: Date): Promise<void>
}

/** 基于 Drizzle 的默认会话存储实现。 */
export class DrizzleSessionStore implements SessionStore {
  constructor(private readonly db: Database = defaultDb) {}

  async insert(record: {
    userId: string
    lastActiveAt: Date
    expiresAt: Date
  }): Promise<SessionRecord> {
    const [row] = await this.db
      .insert(sessions)
      .values({
        userId: record.userId,
        lastActiveAt: record.lastActiveAt,
        expiresAt: record.expiresAt,
      })
      .returning()
    return row as SessionRecord
  }

  async findById(sessionId: string): Promise<SessionRecord | null> {
    const rows = await this.db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    return (rows[0] as SessionRecord | undefined) ?? null
  }

  async updateActivity(
    sessionId: string,
    lastActiveAt: Date,
    expiresAt: Date,
  ): Promise<SessionRecord | null> {
    const rows = await this.db
      .update(sessions)
      .set({ lastActiveAt, expiresAt })
      // 只刷新未撤销的会话，避免复活已登出会话（需求 2.5）。
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
      .returning()
    return (rows[0] as SessionRecord | undefined) ?? null
  }

  async revoke(sessionId: string, revokedAt: Date): Promise<void> {
    await this.db.update(sessions).set({ revokedAt }).where(eq(sessions.id, sessionId))
  }
}

// ---------------------------------------------------------------------------
// Service interfaces
// ---------------------------------------------------------------------------

/** 新建会话的结果（AuthService 接缝的返回契约）。 */
export interface CreatedSession {
  sessionId: string
  expiresAt: Date
}

/**
 * 会话服务的最小接缝（AuthService 任务 3.7 依赖）。
 * 只暴露登录建立会话与登出终止会话两项能力，AuthService 无需感知空闲刷新细节。
 */
export interface SessionService {
  /** 建立空闲过期会话（需求 2.1）。 */
  create(userId: string, now?: Date): Promise<CreatedSession>
  /** 立即终止会话（登出，需求 2.5）。 */
  revoke(sessionId: string, now?: Date): Promise<void>
}

/**
 * 更丰富的会话管理接口（认证中间件任务 3.13 依赖）：在最小接缝之上补充
 * 空闲校验与活跃刷新（需求 2.2, 2.3）。与 `SessionService` 分离，避免为仅需
 * `create`/`revoke` 的 AuthService 强加额外方法。
 */
export interface SessionManager extends SessionService {
  /** 刷新会话活跃时间（有效访问顺延空闲过期，需求 2.2）；已撤销/不存在返回 null。 */
  refresh(sessionId: string, now?: Date): Promise<SessionRecord | null>
  /** `refresh` 的别名（触达会话，刷新其活跃时间）。 */
  touch(sessionId: string, now?: Date): Promise<SessionRecord | null>
  /** 校验并刷新：有效则刷新并返回记录，无效/不存在返回 null（需求 2.2, 2.3, 2.4）。 */
  validateAndTouch(sessionId: string, now?: Date): Promise<SessionRecord | null>
}

/** `DrizzleSessionService` 构造选项。 */
export interface DrizzleSessionServiceOptions {
  /** 会话持久化实现（缺省 `DrizzleSessionStore`，可注入内存替身以测试）。 */
  store?: SessionStore
  /**
   * Drizzle 数据库实例（缺省 `db`）。仅在未显式提供 `store` 时用于构造默认
   * `DrizzleSessionStore`；提供 `store` 时此项被忽略。
   */
  db?: Database
  /** 空闲过期时长（分钟）；缺省取自 `SESSION_IDLE_MINUTES`。 */
  idleMinutes?: number
  /** 时钟（缺省 `() => new Date()`），便于测试控制过期判定。 */
  now?: () => Date
}

/**
 * 基于 Drizzle 的默认会话服务实现（实现 `SessionManager`，即含最小接缝）。
 *
 * - `create` 写入 `Session(lastActiveAt=now, expiresAt=now+idle, revokedAt=null)`（需求 2.1）。
 * - `refresh`/`touch` 在有效访问时刷新 `lastActiveAt` 并顺延 `expiresAt`（需求 2.2）。
 * - `revoke` 置 `revokedAt=now`，立即终止会话（需求 2.5）。
 * - `validateAndTouch` 结合 `isSessionValid` 判定并刷新（需求 2.2, 2.3, 2.4）。
 */
export class DrizzleSessionService implements SessionManager {
  private readonly store: SessionStore
  private readonly idleMinutes: number
  private readonly now: () => Date

  constructor(options: DrizzleSessionServiceOptions = {}) {
    this.store = options.store ?? new DrizzleSessionStore(options.db ?? defaultDb)
    this.idleMinutes = options.idleMinutes ?? getSessionIdleMinutes()
    this.now = options.now ?? (() => new Date())
  }

  /** 由基准时刻计算空闲过期时刻（= 基准 + 空闲窗口）。 */
  private computeExpiry(base: Date): Date {
    return new Date(base.getTime() + this.idleMinutes * MS_PER_MINUTE)
  }

  async create(userId: string, now: Date = this.now()): Promise<CreatedSession> {
    const record = await this.store.insert({
      userId,
      lastActiveAt: now,
      expiresAt: this.computeExpiry(now),
    })
    return { sessionId: record.id, expiresAt: record.expiresAt }
  }

  async refresh(sessionId: string, now: Date = this.now()): Promise<SessionRecord | null> {
    return this.store.updateActivity(sessionId, now, this.computeExpiry(now))
  }

  async touch(sessionId: string, now: Date = this.now()): Promise<SessionRecord | null> {
    return this.refresh(sessionId, now)
  }

  async revoke(sessionId: string, now: Date = this.now()): Promise<void> {
    await this.store.revoke(sessionId, now)
  }

  async validateAndTouch(
    sessionId: string,
    now: Date = this.now(),
  ): Promise<SessionRecord | null> {
    const session = await this.store.findById(sessionId)
    if (!session || !isSessionValid(session, now)) return null
    return this.refresh(sessionId, now)
  }
}
