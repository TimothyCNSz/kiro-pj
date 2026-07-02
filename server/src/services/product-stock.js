// ProductStockService — 商品可兑换库存派生（需求 5.1, 12.2）。
//
// 库存语义（见设计「Data Models · Product」备注与「CDK」表）：
//   - 虚拟商品：可兑换库存 = `COUNT(cdk WHERE productId=? AND status='available')`
//     （可用 CDK 数量为权威来源；`Product.stock` 字段仅作缓存）。
//   - 实物商品：可兑换库存 = `Product.stock`。
//   - 任一类型库存为 0 时该商品视为「已兑完」（sold out，需求 5.1、5.2）。
//
// 本模块把「可用 CDK 计数」抽象为可注入的 {@link CdkCounter} 接缝，并暴露纯谓词
// {@link isSoldOut} 与结构化解析器 {@link ProductStockService}（实现
// {@link StockResolver}）。CatalogService（任务 5.1）可通过该 stock-resolver 接缝
// 注入库存派生能力，无需感知 CDK 存储细节；测试可注入内存替身，避免真实数据库。
//
// Requirements: 5.1, 12.2.
import { and, count, eq } from 'drizzle-orm';
import { db as defaultDb } from '../db/client';
import { cdks } from '../db/schema';
import { ProductType } from '../lib/domain';
/** CDK 可用状态字面量（与 schema `cdk_status` 枚举一致）。 */
export const CDK_AVAILABLE = 'available';
/**
 * 纯谓词：给定可兑换库存数量，是否视为「已兑完」（需求 5.1）。
 *
 * 库存 ≤ 0 即已兑完（负值不应出现，防御性地一并视为已兑完）。无任何副作用，
 * 便于属性化测试（Property 10，任务 5.5）。
 */
export function isSoldOut(availableStock) {
    return !(availableStock > 0);
}
/** 基于 Drizzle 的默认可用 CDK 计数实现。 */
export class DrizzleCdkCounter {
    db;
    constructor(db = defaultDb) {
        this.db = db;
    }
    async countAvailable(productId) {
        const rows = await this.db
            .select({ value: count() })
            .from(cdks)
            .where(and(eq(cdks.productId, productId), eq(cdks.status, CDK_AVAILABLE)));
        return Number(rows[0]?.value ?? 0);
    }
}
/**
 * 商品可兑换库存派生服务。
 *
 * - 虚拟商品：`resolve` 返回可用 CDK 数量（经注入的 {@link CdkCounter}）。
 * - 实物商品：`resolve` 返回 `product.stock`。
 * - `isSoldOut(product)` 便捷判定该商品是否「已兑完」。
 */
export class ProductStockService {
    cdkCounter;
    constructor(options = {}) {
        this.cdkCounter = options.cdkCounter ?? new DrizzleCdkCounter(options.db ?? defaultDb);
    }
    /** 虚拟商品的可兑换库存 = 可用 CDK 数量（需求 5.1、12.2）。 */
    async getVirtualStock(productId) {
        return this.cdkCounter.countAvailable(productId);
    }
    /**
     * 解析商品可兑换库存：虚拟商品取可用 CDK 数，实物商品取 `stock` 字段。
     * 实现 {@link StockResolver}，供 CatalogService 列表/详情视图复用（需求 5.1、12.2）。
     */
    async resolve(product) {
        if (product.type === ProductType.Virtual) {
            return this.getVirtualStock(product.id);
        }
        return product.stock;
    }
    /** 便捷判定：该商品当前是否「已兑完」（可兑换库存为 0，需求 5.1）。 */
    async isSoldOut(product) {
        return isSoldOut(await this.resolve(product));
    }
}
