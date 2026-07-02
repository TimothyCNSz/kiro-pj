// OrderHistoryService — 兑换历史查询、订单详情与积分余额（需求 10.1–10.3, 11.1–11.4）。
//
// 职责（见设计「后端 API 契约」订单/积分分组 + Correctness Property 26）：
//   - listOrders：分页返回当前员工的兑换订单历史，按兑换时间从新到旧排序（需求 11.2），
//     每条记录含商品名称、消耗积分、兑换时间与状态（需求 11.1），并支持分页浏览
//     （需求 11.3）；无任何兑换记录时返回空列表（需求 11.4，空状态由前端呈现）。
//   - getOrder：返回单个订单详情，且**必须限定为订单归属员工**（越权/不存在均返回 null，
//     由路由层转为 404）。实物订单展示配送地址与物流编号（发货后，需求 8.3）；虚拟订单
//     仅在**已发货**后展示关联 CDK，未发货时不展示 CDK（需求 9.3, 9.4；Property 23）。
//   - getBalance：返回当前员工可用积分余额（需求 10.1, 10.2）；始终保证非负（需求 10.3）。
//
// 排序与分页的正确性（Property 26）由「按 createdAt 倒序 + limit/offset 分页」保证：
// 各页记录拼接后恰等于全集（无重复、无遗漏），每页大小不超过页容量。
//
// 设计接缝：所有持久化经可注入的 {@link OrderHistoryRepository} 完成（默认基于 Drizzle），
// 测试可注入内存替身以避免真实数据库。
//
// Requirements: 10.1, 10.2, 10.3, 11.1, 11.2, 11.3, 11.4, 8.3, 9.3, 9.4.
import { OrderStatus as OrderStatusEnum, OrderType as OrderTypeEnum } from '../lib/domain';
/** 分页默认与上限（演示级；与商品列表一致）。 */
export const DEFAULT_HISTORY_PAGE_SIZE = 20;
export const MAX_HISTORY_PAGE_SIZE = 100;
/** 将分页参数规整为安全的 limit/offset（page 从 1 起，非法值回退默认，pageSize 限幅）。 */
export function toLimitOffset(pagination) {
    const page = Number.isFinite(pagination.page) && pagination.page >= 1 ? Math.floor(pagination.page) : 1;
    const pageSize = Number.isFinite(pagination.pageSize) && pagination.pageSize >= 1
        ? Math.min(Math.floor(pagination.pageSize), MAX_HISTORY_PAGE_SIZE)
        : DEFAULT_HISTORY_PAGE_SIZE;
    return { limit: pageSize, offset: (page - 1) * pageSize };
}
/** 从订单记录派生历史列表项（丢弃物流/CDK 明细，仅保留列表所需字段，需求 11.1）。 */
function toHistoryItem(record) {
    return {
        id: record.id,
        type: record.type,
        status: record.status,
        pointsSpent: record.pointsSpent,
        createdAt: record.createdAt,
        items: record.items,
    };
}
/**
 * OrderHistoryService：兑换历史、订单详情与积分余额查询。
 *
 * 全部读取均限定为当前员工自身数据（`userId` 作为强制过滤条件），保证员工只能查看
 * 属于自己的订单与余额（越权访问他人订单返回 null → 404）。
 */
export class OrderHistoryService {
    repository;
    constructor(deps) {
        this.repository = deps.repository;
    }
    /**
     * 分页返回当前员工兑换历史，时间倒序（需求 11.1, 11.2, 11.3）。
     * 无记录时返回空列表（需求 11.4）。
     */
    async listOrders(userId, pagination) {
        const range = toLimitOffset(pagination);
        const { records, total } = await this.repository.listOrders(userId, range);
        const page = Math.floor(range.offset / range.limit) + 1;
        return {
            list: records.map(toHistoryItem),
            total,
            page,
            pageSize: range.limit,
        };
    }
    /**
     * 返回归属当前员工的订单详情；不存在或非本人订单返回 null（路由层转 404）。
     *
     * 视订单类型与状态组织展示（需求 8.3, 9.3, 9.4）：
     *   - 实物：保留配送地址；发货后（`shipped`）带物流编号；CDK 恒为空。
     *   - 虚拟：无配送地址；仅在**已发货**时展示关联 CDK，未发货时不展示（需求 9.3）。
     */
    async getOrder(userId, orderId) {
        const record = await this.repository.getOrder(userId, orderId);
        if (record === null)
            return null;
        const base = toHistoryItem(record);
        const isVirtual = record.type === OrderTypeEnum.Virtual;
        const isShipped = record.status === OrderStatusEnum.Shipped;
        // 虚拟订单仅在已发货后展示 CDK（需求 9.3, 9.4；Property 23）；否则不展示。
        const cdks = isVirtual && isShipped ? await this.repository.listOrderCdkCodes(orderId) : [];
        return {
            ...base,
            // 实物订单保留配送地址；虚拟订单无地址（需求 9.1）。
            shippingAddress: isVirtual ? null : record.shippingAddress,
            // 物流编号仅对实物订单有意义（发货后写入，需求 8.2, 8.3）。
            trackingNo: isVirtual ? null : record.trackingNo,
            cdks,
        };
    }
    /**
     * 返回当前员工可用积分余额（需求 10.1, 10.2）；始终非负（需求 10.3）。
     * 无积分账户视为 0。
     */
    async getBalance(userId) {
        const balance = await this.repository.getBalance(userId);
        // 展示的余额始终不为负数（需求 10.3）——DB CHECK 兜底之上再加一层安全钳制。
        return Math.max(0, balance);
    }
}
// ---------------------------------------------------------------------------
// Drizzle-backed default repository
// ---------------------------------------------------------------------------
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/client';
import { cdks, orderItems, orders, pointsAccounts } from '../db/schema';
/** 基于 Drizzle 的默认兑换历史仓储实现（需求 11 服务端查询）。 */
export class DrizzleOrderHistoryRepository {
    db;
    constructor(db = defaultDb) {
        this.db = db;
    }
    async listOrders(userId, range) {
        // 总数（分页元数据）。
        const totalRows = await this.db
            .select({ count: sql `count(*)::int` })
            .from(orders)
            .where(eq(orders.userId, userId));
        const total = totalRows[0]?.count ?? 0;
        // 本页订单：按兑换时间从新到旧（需求 11.2），limit/offset 分页（需求 11.3）。
        const orderRows = await this.db
            .select({
            id: orders.id,
            userId: orders.userId,
            type: orders.type,
            status: orders.status,
            pointsSpent: orders.pointsSpent,
            shippingAddress: orders.shippingAddress,
            trackingNo: orders.trackingNo,
            createdAt: orders.createdAt,
        })
            .from(orders)
            .where(eq(orders.userId, userId))
            .orderBy(desc(orders.createdAt), desc(orders.id))
            .limit(range.limit)
            .offset(range.offset);
        const itemsByOrder = await this.loadItems(orderRows.map((o) => o.id));
        const records = orderRows.map((o) => this.toRecord(o, itemsByOrder.get(o.id) ?? []));
        return { records, total };
    }
    async getOrder(userId, orderId) {
        const rows = await this.db
            .select({
            id: orders.id,
            userId: orders.userId,
            type: orders.type,
            status: orders.status,
            pointsSpent: orders.pointsSpent,
            shippingAddress: orders.shippingAddress,
            trackingNo: orders.trackingNo,
            createdAt: orders.createdAt,
        })
            .from(orders)
            // 限定为归属该员工的订单：越权访问他人订单等同不存在（返回 null）。
            .where(and(eq(orders.id, orderId), eq(orders.userId, userId)))
            .limit(1);
        const row = rows[0];
        if (!row)
            return null;
        const itemsByOrder = await this.loadItems([orderId]);
        return this.toRecord(row, itemsByOrder.get(orderId) ?? []);
    }
    async listOrderCdkCodes(orderId) {
        const rows = await this.db
            .select({ code: cdks.code })
            .from(cdks)
            .where(eq(cdks.orderId, orderId))
            .orderBy(asc(cdks.id));
        return rows.map((r) => r.code);
    }
    async getBalance(userId) {
        const rows = await this.db
            .select({ balance: pointsAccounts.balance })
            .from(pointsAccounts)
            .where(eq(pointsAccounts.userId, userId))
            .limit(1);
        return rows[0]?.balance ?? 0;
    }
    /** 批量读取给定订单的订单项，按订单分组（保持插入顺序稳定）。 */
    async loadItems(orderIds) {
        const grouped = new Map();
        if (orderIds.length === 0)
            return grouped;
        const rows = await this.db
            .select({
            orderId: orderItems.orderId,
            productId: orderItems.productId,
            productName: orderItems.productName,
            quantity: orderItems.quantity,
            unitPoints: orderItems.unitPoints,
        })
            .from(orderItems)
            .where(inArray(orderItems.orderId, orderIds))
            .orderBy(asc(orderItems.productName), asc(orderItems.id));
        for (const row of rows) {
            const line = {
                productId: row.productId,
                productName: row.productName,
                quantity: row.quantity,
                unitPoints: row.unitPoints,
            };
            const list = grouped.get(row.orderId);
            if (list)
                list.push(line);
            else
                grouped.set(row.orderId, [line]);
        }
        return grouped;
    }
    /** 将订单行 + 订单项组装为领域记录（收敛枚举类型断言）。 */
    toRecord(row, items) {
        return {
            id: row.id,
            userId: row.userId,
            type: row.type,
            status: row.status,
            pointsSpent: row.pointsSpent,
            shippingAddress: row.shippingAddress ?? null,
            trackingNo: row.trackingNo,
            createdAt: row.createdAt,
            items,
        };
    }
}
