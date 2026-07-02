// PointsService — 管理端积分发放/扣除（单个 + 批量部分成功，需求 13.1–13.6, 10.3）。
//
// 职责（见设计「关键服务接口」PointsService + 「批量积分部分成功流程」+ Property 17/19/20）：
//   - adjust(adminId, userId, delta, note?)：对单个员工发放（delta > 0）或扣除
//     （delta < 0）积分（需求 13.1）。若扣除会使余额 < 0 则**阻止并提示余额不足**
//     （INSUFFICIENT_POINTS，需求 13.3）；允许可选备注（需求 13.5）。整个调整在**单个
//     数据库事务**内完成：相对更新余额、记一条积分流水（balanceAfter）、记一条操作日志
//     （points_grant / points_deduct，需求 13.6），三者同成败。
//   - batchAdjust(adminId, userIds[], delta, note?)：对每位员工应用相同 delta（需求 13.2）。
//     扣除时**跳过**余额将变负的员工（收集为 skipped/INSUFFICIENT_BALANCE），其余正常执行
//     （**部分成功**，需求 13.4）；每位**实际执行**调整的员工各记一条流水 + 一条操作日志
//     （需求 13.4、13.6）。每位员工在**各自独立事务**内调整（单员工原子），使某位跳过或
//     失败不影响其余（批量层面部分成功）。
//
// 一致性核心（不因 demo 定位放弃）：员工积分余额**永不为负**（需求 10.3、13.3）——服务层
// 在扣减前显式校验，数据库 `CHECK (balance >= 0)` 为最后一道防线（见 schema）。
//
// 授权约束（仅管理员可调整积分、且不接受客户端直接指定余额，需求 20.2、20.4）由路由层的
// 认证中间件 + adminGuard 保证（见 admin-points.ts）；本服务只经受控的相对增减改变余额，
// 从不接受「目标余额」入参，维系「余额 = 流水累积」（需求 10.2、20.2）。
//
// 设计接缝（依赖可注入，测试用内存替身、不触达真实数据库）：
//   - PointsRepository：以单个事务运行调整（锁账户 → 相对增减 → 记流水），并暴露事务
//     句柄供操作日志在**同一事务内**写入。默认基于 Drizzle（{@link DrizzlePointsRepository}）。
//   - LogService（{@link PointsLogRecorder}）：操作日志记录器，`recordLog(entry, handle)`
//     复用调整事务句柄，使「积分变更 + 操作日志」同成败（需求 13.6）。
//
// Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 10.3.

import { ErrorCode } from '../lib/errors'
import { HttpError } from '../middleware/http-error'
import { LogService, type DbOrTx, type LogEntry } from './log-service'

// ---------------------------------------------------------------------------
// Public request / result shapes
// ---------------------------------------------------------------------------

/** 单次调整后的积分账户视图（面向路由响应）。 */
export interface PointsAccountView {
  /** 员工用户 id。 */
  userId: string
  /** 调整后的当前余额（非负，需求 10.3、13.3）。 */
  balance: number
}

/** 批量调整结果：成功执行与被跳过的员工分区（需求 13.4）。 */
export interface BatchAdjustResult {
  /** 实际执行调整的员工（含调整后余额）。 */
  succeeded: Array<{ userId: string; newBalance: number }>
  /** 被跳过的员工（扣除会使余额变负），附跳过原因。 */
  skipped: Array<{ userId: string; reason: 'INSUFFICIENT_BALANCE' }>
}

// ---------------------------------------------------------------------------
// Transactional repository seam (default: Drizzle; tests: in-memory fake)
// ---------------------------------------------------------------------------

/** 被 `FOR UPDATE` 锁定的积分账户视图（扣减前）。 */
export interface LockedPointsAccount {
  userId: string
  balance: number
}

/** 事务内新增一条积分流水的入参（对应 schema `points_ledger`，需求 13.5、13.6）。 */
export interface PointsLedgerInput {
  /** 流水归属员工。 */
  userId: string
  /** 积分变化量（发放为正、扣除为负）。 */
  delta: number
  /** 变更原因枚举：管理员发放 / 管理员扣除。 */
  reason: 'admin_grant' | 'admin_deduct'
  /** 可选备注（需求 13.5）。 */
  note?: string | null
  /** 变更后余额（= 变更前 + delta），维系「余额 = 流水累积」（需求 10.2、20.2）。 */
  balanceAfter: number
}

/**
 * 单次积分调整事务内的数据访问句柄。默认实现基于单个 Drizzle 事务
 * （{@link DrizzlePointsTx}），全部操作运行在同一事务边界内，随事务整体提交或回滚
 * （积分变更 + 流水 + 操作日志同成败，需求 13.6）。
 */
export interface PointsTx {
  /** `SELECT ... FOR UPDATE` 锁定并读取员工积分账户；不存在返回 null。 */
  lockAccount(userId: string): Promise<LockedPointsAccount | null>
  /**
   * 相对增减余额：`UPDATE ... SET balance = balance + delta, version = version + 1
   * WHERE userId = ?`（delta 可负）。账户已被 `FOR UPDATE` 锁定；`balance >= 0` 由
   * DB `CHECK` 约束兜底（需求 10.3）。
   */
  applyDelta(userId: string, delta: number): Promise<void>
  /** 事务内插入一条积分流水（需求 13.6）。 */
  insertLedger(entry: PointsLedgerInput): Promise<void>
  /**
   * 底层事务/数据库句柄，供操作日志在**同一事务内**写入（需求 13.6）。默认实现返回
   * Drizzle 事务对象；以 `unknown` 松耦合具体持久化类型（与 LogService 的 `handle` 对齐）。
   */
  readonly handle: unknown
}

/**
 * 积分调整事务接缝：以单个数据库事务运行 `fn`，`fn` 抛错即整体回滚。
 * 默认基于 Drizzle 的 `db.transaction`（见 {@link DrizzlePointsRepository}）；
 * 测试可注入内存事务替身。
 */
export interface PointsRepository {
  transaction<T>(fn: (tx: PointsTx) => Promise<T>): Promise<T>
}

/** 操作日志记录器接缝（由 {@link LogService} 实现，需求 13.6）。 */
export type PointsLogRecorder = Pick<LogService, 'recordLog'>

/** `PointsService` 构造依赖（全部可注入以支持无副作用测试）。 */
export interface PointsServiceDependencies {
  /** 积分调整事务仓储（默认 {@link DrizzlePointsRepository}）。 */
  repository?: PointsRepository
  /** 操作日志记录器（默认 {@link LogService}）。 */
  logService?: PointsLogRecorder
}

// ---------------------------------------------------------------------------
// Internal per-user adjust outcome
// ---------------------------------------------------------------------------

/** 单员工调整的内部结果：成功 / 余额不足跳过 / 账户不存在。 */
type AdjustOutcome =
  | { kind: 'ok'; newBalance: number }
  | { kind: 'insufficient' }
  | { kind: 'missing' }

/** 断言 delta 为整数（积分为整数，见 schema），否则以 VALIDATION 拒绝。 */
function assertIntegerDelta(delta: number): void {
  if (typeof delta !== 'number' || !Number.isInteger(delta)) {
    throw new HttpError(ErrorCode.Validation, '积分变更量必须为整数')
  }
}

// ---------------------------------------------------------------------------
// PointsService
// ---------------------------------------------------------------------------

/**
 * PointsService：管理端积分发放/扣除（需求 13.1–13.6, 10.3）。
 *
 * `adjust` 对单个员工在单事务内相对增减余额、记流水与操作日志；扣除会使余额变负时
 * 阻止并提示余额不足（需求 13.3）。`batchAdjust` 对每位员工在各自事务内应用相同 delta，
 * 跳过会变负者、其余正常执行（部分成功，需求 13.4），每位实际执行者各记一条日志（需求 13.6）。
 * 依赖可注入的 {@link PointsRepository} 与 {@link PointsLogRecorder}；默认使用 Drizzle 实现。
 */
export class PointsService {
  private readonly repository: PointsRepository
  private readonly logService: PointsLogRecorder

  constructor(deps: PointsServiceDependencies = {}) {
    this.repository = deps.repository ?? new DrizzlePointsRepository()
    this.logService = deps.logService ?? new LogService()
  }

  /**
   * 对单个员工发放/扣除积分（需求 13.1、13.3、13.5、13.6）。
   *
   * @param adminId 执行操作的管理员 id（操作日志的操作人）。
   * @param userId  目标员工 id。
   * @param delta   积分变化量（> 0 发放、< 0 扣除；须为整数）。
   * @param note    可选备注/原因（需求 13.5），持久化为流水 `note`。
   * @returns 调整后的积分账户视图。
   * @throws HttpError(VALIDATION) delta 非整数，或目标积分账户不存在。
   * @throws HttpError(INSUFFICIENT_POINTS) 扣除会使余额变为负数（需求 13.3）。
   */
  async adjust(
    adminId: string,
    userId: string,
    delta: number,
    note?: string,
  ): Promise<PointsAccountView> {
    assertIntegerDelta(delta)
    const outcome = await this.applyToUser(adminId, userId, delta, note)
    switch (outcome.kind) {
      case 'ok':
        return { userId, balance: outcome.newBalance }
      case 'insufficient':
        // 扣除会使余额变负：阻止并提示余额不足（需求 13.3）。
        throw new HttpError(ErrorCode.InsufficientPoints, '余额不足')
      case 'missing':
        throw new HttpError(ErrorCode.Validation, '积分账户不存在')
    }
  }

  /**
   * 对多个员工批量发放/扣除积分，扣除时跳过会变负者、其余正常执行（部分成功，
   * 需求 13.2、13.4、13.6）。
   *
   * 每位员工在**各自独立事务**内调整（单员工原子），因此某位跳过或失败不影响其余；
   * 每位实际执行调整的员工各记一条流水 + 一条操作日志（需求 13.6）。
   *
   * @param adminId 执行操作的管理员 id。
   * @param userIds 目标员工 id 列表（按给定顺序处理）。
   * @param delta   积分变化量（> 0 发放、< 0 扣除；须为整数）。
   * @param note    可选备注/原因（需求 13.5）。
   * @returns 成功与跳过的分区结果（需求 13.4）。
   * @throws HttpError(VALIDATION) delta 非整数。
   */
  async batchAdjust(
    adminId: string,
    userIds: readonly string[],
    delta: number,
    note?: string,
  ): Promise<BatchAdjustResult> {
    assertIntegerDelta(delta)
    const succeeded: BatchAdjustResult['succeeded'] = []
    const skipped: BatchAdjustResult['skipped'] = []

    for (const userId of userIds) {
      const outcome = await this.applyToUser(adminId, userId, delta, note)
      if (outcome.kind === 'ok') {
        succeeded.push({ userId, newBalance: outcome.newBalance })
      } else {
        // 余额将变负（或账户缺失）：跳过并收集，其余员工继续执行（部分成功，需求 13.4）。
        skipped.push({ userId, reason: 'INSUFFICIENT_BALANCE' })
      }
    }

    return { succeeded, skipped }
  }

  /**
   * 在单个事务内对一位员工执行调整：锁账户 → 校验非负 → 相对增减 → 记流水 → 记操作日志。
   *
   * 余额将变负（或账户缺失）时**不产生任何写入**（事务空提交），返回相应结果供调用方
   * 决定「单个抛错」或「批量跳过」。实际执行时记一条 points_grant/points_deduct 操作日志
   * （复用事务句柄，需求 13.6）。
   */
  private async applyToUser(
    adminId: string,
    userId: string,
    delta: number,
    note?: string,
  ): Promise<AdjustOutcome> {
    return this.repository.transaction(async (tx) => {
      const account = await tx.lockAccount(userId)
      if (account === null) {
        return { kind: 'missing' }
      }

      const newBalance = account.balance + delta
      if (newBalance < 0) {
        // 扣除会使余额变负：不写入，交由调用方处理（单个→抛错；批量→跳过），需求 13.3、13.4。
        return { kind: 'insufficient' }
      }

      const reason: PointsLedgerInput['reason'] = delta >= 0 ? 'admin_grant' : 'admin_deduct'

      // 相对增减余额（balance >= 0 由 DB CHECK 兜底，需求 10.3）。
      await tx.applyDelta(userId, delta)
      // 记一条积分流水（余额 = 流水累积，需求 10.2、13.6、20.2）。
      await tx.insertLedger({ userId, delta, reason, note: note ?? null, balanceAfter: newBalance })
      // 记一条操作日志，复用同一事务句柄（业务变更 + 日志同成败，需求 13.6）。
      const logEntry: LogEntry = {
        actorId: adminId,
        action: delta >= 0 ? 'points_grant' : 'points_deduct',
        targetType: 'user',
        targetId: userId,
      }
      await this.logService.recordLog(logEntry, tx.handle as DbOrTx)

      return { kind: 'ok', newBalance }
    })
  }
}

// ---------------------------------------------------------------------------
// Drizzle-backed default repository
// ---------------------------------------------------------------------------

import { eq, sql } from 'drizzle-orm'

import { db as defaultDb, type Database } from '../db/client'
import { pointsAccounts, pointsLedger } from '../db/schema'

/** Drizzle 事务回调所接收的事务句柄类型（从 `Database['transaction']` 推导）。 */
type DrizzleTx = Parameters<Parameters<Database['transaction']>[0]>[0]

/** 基于单个 Drizzle 事务的 {@link PointsTx} 实现（行锁 + 相对增减）。 */
export class DrizzlePointsTx implements PointsTx {
  constructor(private readonly tx: DrizzleTx) {}

  async lockAccount(userId: string): Promise<LockedPointsAccount | null> {
    const rows = await this.tx
      .select({ userId: pointsAccounts.userId, balance: pointsAccounts.balance })
      .from(pointsAccounts)
      .where(eq(pointsAccounts.userId, userId))
      .for('update')
      .limit(1)
    return rows[0] ?? null
  }

  async applyDelta(userId: string, delta: number): Promise<void> {
    await this.tx
      .update(pointsAccounts)
      .set({
        balance: sql`${pointsAccounts.balance} + ${delta}`,
        version: sql`${pointsAccounts.version} + 1`,
      })
      .where(eq(pointsAccounts.userId, userId))
  }

  async insertLedger(entry: PointsLedgerInput): Promise<void> {
    await this.tx.insert(pointsLedger).values({
      userId: entry.userId,
      delta: entry.delta,
      reason: entry.reason,
      note: entry.note ?? null,
      balanceAfter: entry.balanceAfter,
    })
  }

  get handle(): unknown {
    return this.tx
  }
}

/** 基于 Drizzle `db.transaction` 的默认 {@link PointsRepository} 实现。 */
export class DrizzlePointsRepository implements PointsRepository {
  constructor(private readonly db: Database = defaultDb) {}

  async transaction<T>(fn: (tx: PointsTx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => fn(new DrizzlePointsTx(tx)))
  }
}
