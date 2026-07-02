// AdminUserService — 管理端员工列表查看（需求 24.1, 24.2, 24.3, 24.4, 24.5）。
//
// 职责（见设计「后端 API 契约」管理-员工分组 + AdminUserService 接口 + Property 37）：
//   - listUsers：按邮箱关键字（大小写不敏感子串）过滤 + 分页返回员工列表，每项含
//     userId / email / role / status / balance（余额来自 PointsAccount，只读展示）。
//     q 为空表示浏览全部（需求 24.1, 24.2, 24.4）。结果供积分发放/扣除流程选择目标
//     （需求 24.5）；空状态由空 `list` 表达，前端据此展示「未找到相关员工」（需求 24.3）。
//
// 授权约束（员工不得访问 /admin/users，需求 24.6）由路由层的认证中间件 + adminGuard
// 保证（见 admin-users.ts），不在本服务内重复。
//
// 设计接缝（依赖可注入，测试用内存替身、不触达真实数据库）：
//   - AdminUserRepository：员工列表的数据访问抽象（默认基于 Drizzle，users 左联
//     pointsAccounts 取 balance）。服务层对仓储返回的行再做防御式邮箱过滤，使
//     「过滤结果恰为邮箱匹配子集」（Property 37）无论仓储实现如何都恒成立。
//
// Requirements: 24.1, 24.2, 24.3, 24.4, 24.5.

import type { PaginatedData, PaginationParams } from '../lib/api'
import type { Role, AccountStatus } from '../lib/domain'

/** 管理端员工列表项（设计 AdminUserRow）。balance 来自 PointsAccount，只读展示。 */
export interface AdminUserRow {
  /** 员工用户 id（供积分操作选择目标，需求 24.5）。 */
  userId: string
  /** 邮箱（列表展示与关键字过滤字段，需求 24.1, 24.2）。 */
  email: string
  /** 角色（需求 24.1）。 */
  role: Role
  /** 账号状态（需求 24.1）。 */
  status: AccountStatus
  /** 当前积分余额（来自 PointsAccount.balance；无账户视为 0）。 */
  balance: number
}

/** 仓储返回的一页员工数据（行 + 匹配总数）。 */
export interface AdminUserPage {
  rows: AdminUserRow[]
  total: number
}

/**
 * 员工列表持久化接缝：按邮箱关键字过滤 + 分页返回员工行（含积分余额）。
 * 默认实现基于 Drizzle（见 {@link DrizzleAdminUserRepository}），测试可注入内存替身。
 */
export interface AdminUserRepository {
  /**
   * 返回邮箱包含 `keyword`（大小写不敏感子串；空串表示浏览全部）的员工分页。
   * 每行须含 userId/email/role/status/balance（余额左联 PointsAccount，无账户为 0）。
   */
  listUsers(keyword: string, pagination: PaginationParams): Promise<AdminUserPage>
}

/** `AdminUserService` 构造依赖（可注入以支持无副作用测试）。 */
export interface AdminUserServiceDependencies {
  repository: AdminUserRepository
}

/** 大小写不敏感子串匹配（空关键字视为匹配一切，即「浏览」语义，需求 24.2）。 */
function emailMatches(email: string, keyword: string): boolean {
  const q = keyword.trim().toLowerCase()
  if (q.length === 0) return true
  return email.toLowerCase().includes(q)
}

/**
 * AdminUserService：管理端员工列表查看（需求 24.1, 24.2, 24.3, 24.4, 24.5）。
 *
 * 服务层对仓储返回的行做防御式邮箱过滤，无论仓储实现如何都恒满足 Property 37
 * （过滤结果恰为邮箱匹配子集），并原样透传每项的 userId/email/role/status/balance。
 * 依赖可注入的 {@link AdminUserRepository}；默认使用 Drizzle 实现。
 */
export class AdminUserService {
  private readonly repository: AdminUserRepository

  constructor(deps: AdminUserServiceDependencies) {
    this.repository = deps.repository
  }

  /**
   * 按邮箱关键字过滤 + 分页返回员工列表（需求 24.1, 24.2, 24.4）。
   * `q` 缺省/空串表示浏览全部；无匹配时 `list` 为空，前端据此展示空状态（需求 24.3）。
   */
  async listUsers(query: {
    q?: string
    page: number
    pageSize: number
  }): Promise<PaginatedData<AdminUserRow>> {
    const keyword = typeof query.q === 'string' ? query.q.trim() : ''
    const pagination: PaginationParams = { page: query.page, pageSize: query.pageSize }
    const page = await this.repository.listUsers(keyword, pagination)

    // 防御式不变式：无论仓储实现如何，输出仅含邮箱匹配（或空关键字浏览）的员工（Property 37）。
    const list = page.rows.filter((row) => emailMatches(row.email, keyword))

    return {
      list,
      total: page.total,
      page: pagination.page,
      pageSize: pagination.pageSize,
    }
  }
}

// ---------------------------------------------------------------------------
// Drizzle-backed default repository
// ---------------------------------------------------------------------------

import { count, eq, ilike } from 'drizzle-orm'

import { db as defaultDb, type Database } from '../db/client'
import { pointsAccounts, users } from '../db/schema'

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

/** 转义 ILIKE 通配符，使关键字按字面量子串匹配。 */
function escapeLike(keyword: string): string {
  return keyword.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/**
 * 基于 Drizzle 的默认员工列表仓储：users 左联 pointsAccounts 取当前余额。
 * 无积分账户的用户余额回退为 0；按邮箱升序稳定分页。
 */
export class DrizzleAdminUserRepository implements AdminUserRepository {
  constructor(private readonly db: Database = defaultDb) {}

  async listUsers(keyword: string, pagination: PaginationParams): Promise<AdminUserPage> {
    const { limit, offset } = toLimitOffset(pagination)
    const normalized = keyword.trim()
    // 空关键字浏览全部；否则按邮箱字面量子串（大小写不敏感）过滤。
    const where =
      normalized.length === 0 ? undefined : ilike(users.email, `%${escapeLike(normalized)}%`)

    const rows = await this.db
      .select({
        userId: users.id,
        email: users.email,
        role: users.role,
        status: users.status,
        balance: pointsAccounts.balance,
      })
      .from(users)
      .leftJoin(pointsAccounts, eq(pointsAccounts.userId, users.id))
      .where(where)
      .orderBy(users.email)
      .limit(limit)
      .offset(offset)

    const [totalRow] = await this.db.select({ value: count() }).from(users).where(where)

    return {
      rows: rows.map((row) => ({
        userId: row.userId,
        email: row.email,
        role: row.role as Role,
        status: row.status as AccountStatus,
        // 无积分账户（leftJoin 未命中）时余额视为 0。
        balance: row.balance ?? 0,
      })),
      total: totalRow?.value ?? 0,
    }
  }
}
