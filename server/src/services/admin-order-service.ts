// AdminOrderService — 管理端订单列表查询（供发货管理页展示与选择，需求 8、9、14）。
//
// 员工侧 OrderHistoryService 只查本人订单；管理端发货需要跨所有员工列出订单，并可按
// 状态（待发货/已发货）与类型（实物/虚拟）筛选、分页。本服务只读，联表返回发货所需信息：
// 订单基本信息 + 下单员工邮箱 + 订单项摘要 + 实物物流编号 + 已发货虚拟订单的 CDK + 收货地址。
//
// 仅供管理端使用（路由经管理员 Guard）。

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'

import { db as defaultDb, type Database } from '../db/client'
import { cdks, orderItems, orders, users } from '../db/schema'
import type { OrderStatus, OrderType } from '../lib/domain'
import type { PaginatedData } from '../lib/api'

/** 管理端订单列表项。 */
export interface AdminOrderRow {
  id: string
  /** 下单员工邮箱。 */
  userEmail: string
  type: OrderType
  status: OrderStatus
  pointsSpent: number
  createdAt: Date
  /** 订单项摘要（商品名 + 数量）。 */
  items: Array<{ productName: string; quantity: number }>
  /** 实物物流编号（已发货实物订单）；否则 null。 */
  trackingNo: string | null
  /** 收货地址（实物订单）；否则 null。 */
  shippingAddress: Record<string, unknown> | null
  /** 已交付 CDK（仅已发货虚拟订单展示）。 */
  cdks: string[]
}

/** 列表查询入参。 */
export interface ListAdminOrdersParams {
  /** 按状态筛选；缺省不限。 */
  status?: OrderStatus
  /** 按类型筛选；缺省不限。 */
  type?: OrderType
  page: number
  pageSize: number
}

const MAX_PAGE_SIZE = 100

/** 管理端订单查询服务（只读，直接基于 Drizzle）。 */
export class AdminOrderService {
  constructor(private readonly db: Database = defaultDb) {}

  async listOrders(params: ListAdminOrdersParams): Promise<PaginatedData<AdminOrderRow>> {
    const page = Number.isFinite(params.page) && params.page >= 1 ? Math.floor(params.page) : 1
    const pageSize =
      Number.isFinite(params.pageSize) && params.pageSize >= 1
        ? Math.min(Math.floor(params.pageSize), MAX_PAGE_SIZE)
        : 20
    const offset = (page - 1) * pageSize

    const conds = []
    if (params.status) conds.push(eq(orders.status, params.status))
    if (params.type) conds.push(eq(orders.type, params.type))
    const where = conds.length > 0 ? and(...conds) : undefined

    const totalRows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(orders)
      .where(where)
    const total = totalRows[0]?.count ?? 0

    const rows = await this.db
      .select({
        id: orders.id,
        type: orders.type,
        status: orders.status,
        pointsSpent: orders.pointsSpent,
        shippingAddress: orders.shippingAddress,
        trackingNo: orders.trackingNo,
        createdAt: orders.createdAt,
        userEmail: users.email,
      })
      .from(orders)
      .innerJoin(users, eq(orders.userId, users.id))
      .where(where)
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(pageSize)
      .offset(offset)

    const ids = rows.map((r) => r.id)
    const itemsByOrder = await this.loadItems(ids)
    const cdksByOrder = await this.loadDeliveredCdks(ids)

    const list: AdminOrderRow[] = rows.map((r) => ({
      id: r.id,
      userEmail: r.userEmail,
      type: r.type as OrderType,
      status: r.status as OrderStatus,
      pointsSpent: r.pointsSpent,
      createdAt: r.createdAt,
      items: itemsByOrder.get(r.id) ?? [],
      trackingNo: r.trackingNo,
      shippingAddress: (r.shippingAddress as Record<string, unknown> | null) ?? null,
      cdks: cdksByOrder.get(r.id) ?? [],
    }))

    return { list, total, page, pageSize }
  }

  private async loadItems(
    orderIds: string[],
  ): Promise<Map<string, Array<{ productName: string; quantity: number }>>> {
    const grouped = new Map<string, Array<{ productName: string; quantity: number }>>()
    if (orderIds.length === 0) return grouped
    const rows = await this.db
      .select({
        orderId: orderItems.orderId,
        productName: orderItems.productName,
        quantity: orderItems.quantity,
      })
      .from(orderItems)
      .where(inArray(orderItems.orderId, orderIds))
      .orderBy(asc(orderItems.productName), asc(orderItems.id))
    for (const row of rows) {
      const line = { productName: row.productName, quantity: row.quantity }
      const list = grouped.get(row.orderId)
      if (list) list.push(line)
      else grouped.set(row.orderId, [line])
    }
    return grouped
  }

  private async loadDeliveredCdks(orderIds: string[]): Promise<Map<string, string[]>> {
    const grouped = new Map<string, string[]>()
    if (orderIds.length === 0) return grouped
    const rows = await this.db
      .select({ orderId: cdks.orderId, code: cdks.code })
      .from(cdks)
      .where(inArray(cdks.orderId, orderIds))
      .orderBy(asc(cdks.id))
    for (const row of rows) {
      if (!row.orderId) continue
      const list = grouped.get(row.orderId)
      if (list) list.push(row.code)
      else grouped.set(row.orderId, [row.code])
    }
    return grouped
  }
}
