// RedemptionService — 兑换（结算）事务核心（需求 7.4, 7.8, 7.10, 19.2, 19.4）。
//
// 本模块实现「单次兑换事务的原子一致性」这一强约束（需求 7.8、19.2）：一次兑换的
// 积分扣除与所有商品库存扣减在**同一数据库事务**内整体成功或整体失败，绝不产生部
// 分扣减。跨请求并发下的防超卖/防透支为**演示级尽力而为**（需求 7.10、19.4）——以
// 行锁（悲观）+ 版本条件更新（乐观）作为实现手段，但不承诺高并发强 SLA。
//
// 事务体（见设计「兑换事务」Drizzle 示意）：
//   1. 以**稳定顺序**锁行防死锁：先锁积分账户，再按 `productId` 升序 `FOR UPDATE`
//      锁定各商品行（含 `version`）。
//   2. 校验：余额 >= 应付总额（否则 INSUFFICIENT_POINTS）、每商品请求数量 <= 库存
//      （否则 INSUFFICIENT_STOCK）；任一校验失败即 throw → 整体回滚、无任何扣减。
//   3. 版本条件更新库存：`UPDATE ... WHERE id=? AND version=?` 相对扣减
//      （`stock = stock - qty`, `version = version + 1`）；影响行数为 0 视为并发修改
//      （{@link ConcurrencyConflictError}）→ 回滚并**有限次重试**（需求 7.10、19.4）。
//   4. 相对扣减积分余额（`balance = balance - totalCost`，`balance >= 0` 由 DB
//      `CHECK` 约束兜底，见 schema）。
//
// 扩展接缝（本任务只实现事务核心，后续任务经 {@link RedemptionHooks} 无侵入扩展）：
//   - 任务 8.4：`preValidate` —— 无副作用的前置校验（含实物缺地址等），在任何扣减
//     之前 throw 即整体回滚。
//   - 任务 8.6：`applyEffects` —— 事务内按类型拆分生成实物/虚拟订单、订单项归类。
//   - 任务 8.9：`applyEffects` —— 事务内消耗 CDK、记积分流水、移除购物车已兑项、
//     对降为 0 的库存触发低库存提醒。
//
// 数据访问经可注入的 {@link RedemptionStore} 接缝完成：默认基于 Drizzle 的
// `db.transaction` + `.for('update')` + 版本条件更新（{@link DrizzleRedemptionStore}），
// 测试可注入内存事务替身以脱离真实 PostgreSQL 验证原子性、重试与相对扣减。
//
// Requirements: 7.4, 7.8, 7.10, 19.2, 19.4.
import { ErrorCode } from '../lib/errors';
import { HttpError } from '../middleware/http-error';
import { assertWithinStock } from './stock-guard';
// ---------------------------------------------------------------------------
// Concurrency conflict error (需求 7.10, 19.4)
// ---------------------------------------------------------------------------
/**
 * 并发版本冲突：版本条件库存更新影响行数为 0，说明另一并发事务已修改该商品行。
 * 映射到 {@link ErrorCode.ConcurrencyConflict}（HTTP 409）。事务核心据此回滚并做
 * 有限次重试；重试仍冲突则最终抛出（由统一错误中间件序列化为 409）。
 */
export class ConcurrencyConflictError extends HttpError {
    constructor(message = '兑换处理发生并发冲突，请稍后重试') {
        super(ErrorCode.ConcurrencyConflict, message);
        this.name = 'ConcurrencyConflictError';
        // Restore prototype chain for `instanceof` under transpilation targets.
        Object.setPrototypeOf(this, ConcurrencyConflictError.prototype);
    }
}
/** 默认并发冲突重试次数（演示级；需求 7.10、19.4 尽力而为）。 */
const DEFAULT_MAX_RETRIES = 3;
// ---------------------------------------------------------------------------
// RedemptionService
// ---------------------------------------------------------------------------
/**
 * RedemptionService：单事务兑换核心。
 *
 * `checkout` 将整个兑换封装在一个数据库事务内（经 {@link RedemptionStore}）：稳定
 * 顺序锁行 → 校验余额/库存 → 版本条件相对扣减库存 → 相对扣减积分。任一步抛错整体
 * 回滚（原子性，需求 7.8、19.2）；库存版本条件更新影响行数为 0 视为并发冲突，回滚
 * 并有限次重试（演示级尽力而为，需求 7.10、19.4）。
 */
export class RedemptionService {
    store;
    hooks;
    maxRetries;
    constructor(deps = {}) {
        this.store = deps.store ?? new DrizzleRedemptionStore();
        this.hooks = deps.hooks ?? {};
        this.maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
    }
    /**
     * 执行一次兑换（结算 / 立即兑换共用核心，需求 7.4、7.8）。
     *
     * @param userId 兑换发起员工。
     * @param items  待兑换商品项（同一商品重复项按数量合并）。
     * @param options 兑换选项（可含实物配送地址，透传给接缝）。
     * @returns 兑换结果（明细、应付总额、扣减前后余额）。
     * @throws HttpError(VALIDATION) items 为空或数量非法。
     * @throws HttpError(INVALID_PRODUCT_FIELD) 存在不存在的商品。
     * @throws HttpError(INSUFFICIENT_POINTS) 余额不足以支付应付总额（需求 7.4、5.4）。
     * @throws HttpError(INSUFFICIENT_STOCK) 任一商品请求数量超过库存（需求 5.5、7）。
     * @throws ConcurrencyConflictError 重试仍存在并发版本冲突（需求 7.10、19.4）。
     */
    async checkout(userId, items, options = {}) {
        const normalized = normalizeItems(items);
        // 有限次重试：并发版本冲突回滚后重试（需求 7.10、19.4）。其余错误立即抛出。
        let attempt = 0;
        for (;;) {
            try {
                return await this.store.transaction((tx) => this.runCheckout(tx, userId, normalized, options.address));
            }
            catch (err) {
                if (err instanceof ConcurrencyConflictError && attempt < this.maxRetries) {
                    attempt += 1;
                    continue;
                }
                throw err;
            }
        }
    }
    /**
     * 单次事务体（可能被重试多次调用；每次都在全新事务内重新锁行读取最新版本）。
     */
    async runCheckout(tx, userId, items, address) {
        // 1) 稳定顺序锁行防死锁：先积分账户，再商品按 productId 升序（需求 7.10）。
        const account = await tx.lockPointsAccount(userId);
        if (account === null) {
            throw new HttpError(ErrorCode.InsufficientPoints, '积分账户不存在或积分不足');
        }
        const sortedIds = items.map((it) => it.productId).sort();
        const locked = await tx.lockProductsAscending(sortedIds);
        const byId = new Map(locked.map((p) => [p.id, p]));
        // 构建兑换明细（保持 productId 升序，与锁定顺序一致）。
        const lines = sortedIds.map((productId) => {
            const product = byId.get(productId);
            if (!product) {
                throw new HttpError(ErrorCode.InvalidProductField, `商品不存在：${productId}`);
            }
            const quantity = items.find((it) => it.productId === productId).quantity;
            return { productId, quantity, product, cost: product.pointsCost * quantity };
        });
        const totalCost = lines.reduce((sum, line) => sum + line.cost, 0);
        const ctx = { userId, account, lines, totalCost, address };
        // 2a) 扩展前置校验接缝（任务 8.4）：无副作用，抛错在任何扣减前整体回滚。
        await this.hooks.preValidate?.(ctx);
        // 2b) 核心校验（本任务）：余额 >= 应付总额；每商品请求数量 <= 库存。
        //     失败即 throw → 整体回滚、无任何扣减（需求 7.4、7.8、5.4、5.5）。
        assertSufficientPoints(account, totalCost);
        assertSufficientStock(lines);
        // 3) 版本条件相对扣减库存：影响行数为 0 视为并发修改 → 回滚重试（需求 7.10、19.4）。
        for (const line of lines) {
            const affected = await tx.decrementProductStock(line.productId, line.quantity, line.product.version);
            if (affected === 0) {
                throw new ConcurrencyConflictError();
            }
        }
        // 4) 相对扣减积分余额（balance >= 0 由 DB CHECK 兜底，需求 10.3）。
        await tx.decrementBalance(userId, totalCost);
        // 5) 副作用扩展接缝（任务 8.6 拆单 / 8.9 CDK·流水·购物车·低库存提醒），仍在事务内。
        await this.hooks.applyEffects?.(ctx, tx);
        return {
            userId,
            lines,
            totalCost,
            balanceBefore: account.balance,
            balanceAfter: account.balance - totalCost,
        };
    }
}
// ---------------------------------------------------------------------------
// Pure helpers (无副作用，便于独立验证)
// ---------------------------------------------------------------------------
/**
 * 归一化兑换项：校验非空、数量为 >= 1 的整数，并合并同一商品的重复项（数量累加）。
 * 返回按 `productId` 升序排列的明细，便于稳定锁定顺序。
 */
export function normalizeItems(items) {
    if (!Array.isArray(items) || items.length === 0) {
        throw new HttpError(ErrorCode.Validation, '兑换商品项不能为空');
    }
    const merged = new Map();
    for (const item of items) {
        if (typeof item.productId !== 'string' || item.productId.length === 0) {
            throw new HttpError(ErrorCode.Validation, '兑换商品项缺少有效的 productId');
        }
        if (typeof item.quantity !== 'number' ||
            !Number.isInteger(item.quantity) ||
            item.quantity < 1) {
            throw new HttpError(ErrorCode.Validation, '兑换数量必须为不小于 1 的整数');
        }
        merged.set(item.productId, (merged.get(item.productId) ?? 0) + item.quantity);
    }
    return [...merged.entries()]
        .map(([productId, quantity]) => ({ productId, quantity }))
        .sort((a, b) => a.productId.localeCompare(b.productId));
}
/** 断言余额足以支付应付总额，否则以 INSUFFICIENT_POINTS 拒绝（需求 7.4、5.4）。 */
export function assertSufficientPoints(account, totalCost) {
    if (account.balance < totalCost) {
        throw new HttpError(ErrorCode.InsufficientPoints, '积分不足');
    }
}
/**
 * 断言每商品请求数量均不超过其锁定库存，否则以 INSUFFICIENT_STOCK 拒绝
 * （复用 {@link assertWithinStock}，需求 5.5、7）。
 */
export function assertSufficientStock(lines) {
    const checks = lines.map((line) => ({
        productId: line.productId,
        name: line.product.name,
        requestedQuantity: line.quantity,
        availableStock: line.product.stock,
    }));
    assertWithinStock(checks);
}
// ---------------------------------------------------------------------------
// Drizzle-backed default store
// ---------------------------------------------------------------------------
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/client';
import { cartItems, carts, cdks, orderItems, orders, pointsAccounts, pointsLedger, products, } from '../db/schema';
/** 基于单个 Drizzle 事务的 {@link RedemptionTx} 实现（行锁 + 版本条件更新）。 */
export class DrizzleRedemptionTx {
    tx;
    constructor(tx) {
        this.tx = tx;
    }
    async lockPointsAccount(userId) {
        const rows = await this.tx
            .select({
            userId: pointsAccounts.userId,
            balance: pointsAccounts.balance,
            version: pointsAccounts.version,
        })
            .from(pointsAccounts)
            .where(eq(pointsAccounts.userId, userId))
            .for('update')
            .limit(1);
        return rows[0] ?? null;
    }
    async lockProductsAscending(productIds) {
        if (productIds.length === 0)
            return [];
        const rows = await this.tx
            .select({
            id: products.id,
            name: products.name,
            type: products.type,
            pointsCost: products.pointsCost,
            stock: products.stock,
            version: products.version,
        })
            .from(products)
            .where(inArray(products.id, [...productIds]))
            // 升序锁定，保证并发事务以一致顺序获取行锁，避免死锁（需求 7.10）。
            .orderBy(asc(products.id))
            .for('update');
        return rows.map((r) => ({ ...r, type: r.type }));
    }
    async decrementProductStock(productId, quantity, expectedVersion) {
        // 版本条件相对扣减；返回受影响行数（0 => 版本不匹配 => 并发冲突）。
        const updated = await this.tx
            .update(products)
            .set({
            stock: sql `${products.stock} - ${quantity}`,
            version: sql `${products.version} + 1`,
        })
            .where(and(eq(products.id, productId), eq(products.version, expectedVersion)))
            .returning({ id: products.id });
        return updated.length;
    }
    async decrementBalance(userId, amount) {
        await this.tx
            .update(pointsAccounts)
            .set({
            balance: sql `${pointsAccounts.balance} - ${amount}`,
            version: sql `${pointsAccounts.version} + 1`,
        })
            .where(eq(pointsAccounts.userId, userId));
    }
    async insertOrder(order) {
        const inserted = await this.tx
            .insert(orders)
            .values({
            userId: order.userId,
            type: order.type,
            pointsSpent: order.pointsSpent,
            shippingAddress: order.shippingAddress ?? null,
        })
            .returning({ id: orders.id });
        return inserted[0].id;
    }
    async insertOrderItems(orderId, items) {
        if (items.length === 0)
            return;
        await this.tx.insert(orderItems).values(items.map((it) => ({
            orderId,
            productId: it.productId,
            productName: it.productName,
            quantity: it.quantity,
            unitPoints: it.unitPoints,
        })));
    }
    async consumeCdks(productId, quantity, orderId) {
        if (quantity <= 0)
            return;
        // 锁定并选取最早的 `quantity` 个可用 CDK（稳定顺序），每虚拟单位消耗 1 个（需求 9.2）。
        const available = await this.tx
            .select({ id: cdks.id })
            .from(cdks)
            .where(and(eq(cdks.productId, productId), eq(cdks.status, 'available')))
            .orderBy(asc(cdks.id))
            .limit(quantity)
            .for('update');
        if (available.length < quantity) {
            // 一致性兜底：正常流程已在锁定/库存校验阶段拦截（虚拟库存=可用 CDK 数，需求 5.1）。
            throw new HttpError(ErrorCode.InsufficientStock, `虚拟商品可用兑换码不足：${productId}`);
        }
        await this.tx
            .update(cdks)
            .set({ status: 'consumed', orderId })
            .where(inArray(cdks.id, available.map((r) => r.id)));
    }
    async insertPointsLedger(entry) {
        await this.tx.insert(pointsLedger).values({
            userId: entry.userId,
            delta: entry.delta,
            reason: entry.reason,
            note: entry.note ?? null,
            balanceAfter: entry.balanceAfter,
        });
    }
    async removeCartItems(userId, productIds) {
        if (productIds.length === 0)
            return;
        const cartRows = await this.tx
            .select({ id: carts.id })
            .from(carts)
            .where(eq(carts.userId, userId))
            .limit(1);
        const cartId = cartRows[0]?.id;
        if (!cartId)
            return; // 无购物车（如立即兑换）——幂等无操作（需求 7.5）。
        await this.tx
            .delete(cartItems)
            .where(and(eq(cartItems.cartId, cartId), inArray(cartItems.productId, [...productIds])));
    }
    get handle() {
        return this.tx;
    }
}
/** 基于 Drizzle `db.transaction` 的默认 {@link RedemptionStore} 实现。 */
export class DrizzleRedemptionStore {
    db;
    constructor(db = defaultDb) {
        this.db = db;
    }
    async transaction(fn) {
        return this.db.transaction(async (tx) => fn(new DrizzleRedemptionTx(tx)));
    }
}
