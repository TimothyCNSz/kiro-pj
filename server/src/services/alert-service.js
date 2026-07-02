// AlertService — 低库存提醒（去重触发 + 后台展示，需求 5.3, 15.1, 15.2）。
//
// 职责（见设计「后端 API 契约」管理-提醒分组 + Correctness Property 25）：
//   - triggerLowStock：当商品库存因兑换降为 0 时，为该商品记录一条低库存提醒
//     （需求 5.3——库存降为 0 是低库存提醒的**唯一触发点**）。去重语义由
//     `LowStockAlert.productId` 唯一索引 + `onConflictDoNothing` 兜底：对同一商品
//     多次触发**至多产生一条**提醒、不重复触发（需求 15.1；Property 25）。因此
//     该方法**幂等**——重复调用不会创建重复行。
//   - listLowStock：返回当前（未解除）低库存提醒，供管理员后台展示（需求 15.2）。
//
// 事务参与（关键，见任务 8.9 依赖说明）：
//   兑换事务副作用（RedemptionService，任务 8.9）在扣减库存后、于**同一数据库事务内**
//   对降为 0 的库存调用 `triggerLowStock(productId, tx)`。为此本服务的写入方法接受一个
//   **可选的事务/数据库句柄**（{@link DbOrTx}）：传入则复用调用方事务（提醒与兑换同成败），
//   省略则使用模块作用域的默认连接自成一次写入。写入能力须不晚于任务 8.9 可用。
//
// 设计接缝（依赖可注入，测试用内存替身、不触达真实数据库）：
//   - AlertGateway：低库存提醒的数据访问抽象（默认基于 Drizzle）。去重写入在 SQL 层
//     依赖唯一索引 + `onConflictDoNothing`；内存替身以 productId 为键模拟同一「至多一条」
//     语义，使 Property 25（去重）可脱离真实数据库独立验证。
//
// Requirements: 5.3, 15.1, 15.2.
import { desc, eq, isNull } from 'drizzle-orm';
import { db as defaultDb } from '../db/client';
import { lowStockAlerts, products } from '../db/schema';
/** 基于 Drizzle 的默认低库存提醒网关实现。 */
export class DrizzleAlertGateway {
    db;
    constructor(db = defaultDb) {
        this.db = db;
    }
    async insertAlertIgnoringDuplicate(productId, handle) {
        // 复用调用方事务（若提供），否则使用默认连接自成一次写入。
        const exec = (handle ?? this.db);
        // 去重兜底：productId 唯一索引 + onConflictDoNothing——重复触发不产生重复行（需求 15.1）。
        await exec.insert(lowStockAlerts).values({ productId }).onConflictDoNothing();
    }
    async listActiveAlerts() {
        return this.db
            .select({
            id: lowStockAlerts.id,
            productId: lowStockAlerts.productId,
            productName: products.name,
            triggeredAt: lowStockAlerts.triggeredAt,
        })
            .from(lowStockAlerts)
            .innerJoin(products, eq(products.id, lowStockAlerts.productId))
            .where(isNull(lowStockAlerts.resolvedAt))
            .orderBy(desc(lowStockAlerts.triggeredAt));
    }
}
/**
 * AlertService：低库存提醒的去重触发与后台展示（需求 5.3, 15.1, 15.2）。
 * 依赖可注入的 {@link AlertGateway}；默认使用 Drizzle 实现。
 */
export class AlertService {
    gateway;
    constructor(options = {}) {
        this.gateway = options.gateway ?? new DrizzleAlertGateway(options.db ?? defaultDb);
    }
    /**
     * 触发某商品的低库存提醒（库存降为 0 的唯一触发点，需求 5.3）。
     *
     * **幂等**：对同一 productId 多次调用至多产生一条提醒（去重，需求 15.1）。被兑换事务
     * 副作用（任务 8.9）在同一事务内调用；传入 `handle` 以复用该事务。
     *
     * @param productId 库存降为 0 的商品 id。
     * @param handle 可选事务/数据库句柄；省略时使用默认连接。
     */
    async triggerLowStock(productId, handle) {
        await this.gateway.insertAlertIgnoringDuplicate(productId, handle);
    }
    /** 返回当前库存不足的提醒列表，供管理员后台展示（需求 15.2）。 */
    async listLowStock() {
        return this.gateway.listActiveAlerts();
    }
}
