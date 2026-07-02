// LogService — 操作日志（记录 + 时间倒序展示，需求 16.1, 16.2, 14.4）。
//
// 职责（见设计「后端 API 契约」管理-日志分组 + Correctness Property 27）：
//   - recordLog：为一次管理操作记录一条操作日志，包含操作人（actorId）、操作类型
//     （action）、操作对象（targetType/targetId）与操作时间（createdAt，由数据库
//     默认 now() 落库）。适用的操作类型见 {@link OperationAction}：商品增改
//     （product_create/product_update）、上下架（product_status）、积分发放/扣除
//     （points_grant/points_deduct）、实物/虚拟发货（ship_physical/ship_virtual）
//     （需求 16.1, 14.4）。
//   - listLogs：按操作时间从新到旧（createdAt 倒序）分页返回日志（需求 16.2）。
//
// 事务参与（关键，与 AlertService 一致的接缝）：
//   积分（PointsService，任务 11.1/11.5）与发货（FulfillmentService，任务 10.1/10.4）
//   服务在**各自的数据库事务内**调用 `recordLog(entry, tx)` 以保证「业务变更 + 日志」
//   同成败。为此写入方法接受一个**可选的事务/数据库句柄**（{@link DbOrTx}）：传入则
//   复用调用方事务，省略则使用模块作用域的默认连接自成一次写入。
//
// 设计接缝（依赖可注入，测试用内存替身、不触达真实数据库）：
//   - LogGateway：操作日志的数据访问抽象（默认基于 Drizzle）。倒序 + 分页在 SQL 层
//     以 `ORDER BY created_at DESC` + LIMIT/OFFSET 实现；内存替身以插入顺序模拟
//     同一「时间倒序」语义，使 Property 27 可脱离真实数据库独立验证。
//
// Requirements: 16.1, 16.2, 14.4.

import { desc } from 'drizzle-orm'

import { db as defaultDb, type Database } from '../db/client'
import type { PaginatedData, PaginationParams } from '../lib/api'
import { operationLogs, type NewOperationLog } from '../db/schema'

/**
 * 数据库或事务句柄：既可传入模块作用域的 {@link Database}，也可传入
 * `db.transaction(async (tx) => ...)` 回调中的事务对象 `tx`。二者查询接口一致，
 * 使写入既能独立执行、也能参与调用方（积分/发货）事务。
 */
type TransactionHandle = Parameters<Parameters<Database['transaction']>[0]>[0]
export type DbOrTx = Database | TransactionHandle

/**
 * 操作日志的操作类型联合（需求 16.1, 14.4）。直接派生自 schema 的 operation_action
 * 枚举列，使服务、路由与持久化层保持同步。
 */
export type OperationAction = NonNullable<NewOperationLog['action']>

/** recordLog 入参：一条操作日志的语义字段（需求 16.1）。 */
export interface LogEntry {
  /** 操作人（管理员）id。 */
  actorId: string
  /** 操作类型。 */
  action: OperationAction
  /** 操作对象类型（如 'product'、'user'、'order'）。 */
  targetType: string
  /** 操作对象 id；对象无明确 id 时可为空。 */
  targetId?: string | null
}

/** 后台展示用的操作日志视图项（需求 16.2）。 */
export interface OperationLogView {
  /** 日志 id。 */
  id: string
  /** 操作人 id。 */
  actorId: string
  /** 操作类型。 */
  action: OperationAction
  /** 操作对象类型。 */
  targetType: string
  /** 操作对象 id（可空）。 */
  targetId: string | null
  /** 操作时间。 */
  createdAt: Date
}

/** 仓储返回的一页日志（行 + 总数）。 */
export interface LogPage {
  rows: OperationLogView[]
  total: number
}

/**
 * 操作日志持久化接缝：写入一条日志 + 时间倒序分页查询。
 * 默认实现基于 Drizzle（见 {@link DrizzleLogGateway}），测试可注入内存替身。
 */
export interface LogGateway {
  /**
   * 插入一条操作日志（需求 16.1）。
   * @param handle 可选事务/数据库句柄；传入则在调用方事务内写入。
   */
  insertLog(entry: LogEntry, handle?: DbOrTx): Promise<void>
  /** 按 createdAt 倒序分页返回日志（需求 16.2）。 */
  listLogs(pagination: PaginationParams): Promise<LogPage>
}

/** 计算 SQL LIMIT/OFFSET（page 从 1 起，非法值回退安全默认）。 */
function toLimitOffset(pagination: PaginationParams): { limit: number; offset: number } {
  const page =
    Number.isFinite(pagination.page) && pagination.page > 0 ? Math.floor(pagination.page) : 1
  const pageSize =
    Number.isFinite(pagination.pageSize) && pagination.pageSize > 0
      ? Math.floor(pagination.pageSize)
      : 20
  return { limit: pageSize, offset: (page - 1) * pageSize }
}

/** 基于 Drizzle 的默认操作日志网关实现。 */
export class DrizzleLogGateway implements LogGateway {
  constructor(private readonly db: Database = defaultDb) {}

  async insertLog(entry: LogEntry, handle?: DbOrTx): Promise<void> {
    // 复用调用方事务（若提供），否则使用默认连接自成一次写入。
    const exec = (handle ?? this.db) as Database
    await exec.insert(operationLogs).values({
      actorId: entry.actorId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId ?? null,
    })
  }

  async listLogs(pagination: PaginationParams): Promise<LogPage> {
    const { limit, offset } = toLimitOffset(pagination)
    const rows = await this.db
      .select({
        id: operationLogs.id,
        actorId: operationLogs.actorId,
        action: operationLogs.action,
        targetType: operationLogs.targetType,
        targetId: operationLogs.targetId,
        createdAt: operationLogs.createdAt,
      })
      .from(operationLogs)
      // 时间倒序：最新的日志排在最前（需求 16.2）。
      .orderBy(desc(operationLogs.createdAt))
      .limit(limit)
      .offset(offset)

    const counted = await this.db.select({ id: operationLogs.id }).from(operationLogs)

    return { rows: rows as OperationLogView[], total: counted.length }
  }
}

/**
 * LogService：操作日志的记录与时间倒序展示（需求 16.1, 16.2, 14.4）。
 * 依赖可注入的 {@link LogGateway}；默认使用 Drizzle 实现。
 */
export class LogService {
  private readonly gateway: LogGateway

  constructor(options: { gateway?: LogGateway; db?: Database } = {}) {
    this.gateway = options.gateway ?? new DrizzleLogGateway(options.db ?? defaultDb)
  }

  /**
   * 记录一条操作日志（需求 16.1, 14.4）。
   *
   * 积分/发货服务在**各自事务内**调用并传入 `handle` 以复用该事务，使「业务变更 + 日志」
   * 同成败；省略 `handle` 时使用默认连接自成一次写入。
   *
   * @param entry 含操作人/类型/对象的日志条目。
   * @param handle 可选事务/数据库句柄；省略时使用默认连接。
   */
  async recordLog(entry: LogEntry, handle?: DbOrTx): Promise<void> {
    await this.gateway.insertLog(entry, handle)
  }

  /**
   * 分页返回操作日志，按操作时间从新到旧排序（需求 16.2）。
   */
  async listLogs(pagination: PaginationParams): Promise<PaginatedData<OperationLogView>> {
    const page = await this.gateway.listLogs(pagination)
    return {
      list: page.rows,
      total: page.total,
      page: pagination.page,
      pageSize: pagination.pageSize,
    }
  }
}
