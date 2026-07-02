// RedemptionEffects — 兑换事务副作用集成（需求 7.5, 9.2, 5.3）。
//
// 本模块提供 {@link RedemptionHooks.applyEffects} 钩子的实现：在 RedemptionService
// 完成积分/库存的相对扣减之后、仍在**同一数据库事务内**执行兑换的全部副作用（见
// 设计「兑换事务」序列图的提交前步骤）。任一步抛错即随事务整体回滚（原子性延伸至
// 副作用，需求 7.8、19.2）。
//
// 事务内副作用（顺序固定，便于测试与推理）：
//   1. 拆单与落库：调用 {@link splitOrdersByType} 按商品类型将兑换明细拆分为实物/
//      虚拟订单草稿（需求 7.9），逐份 INSERT 订单及其订单项（下单快照）。
//   2. 虚拟发货消耗 CDK：对**虚拟订单**的每个订单项，消耗其数量对应的可用 CDK
//      （每虚拟单位消耗 1 个 CDK，需求 9.2），置为 consumed 并关联订单。
//   3. 积分流水：为本次兑换记一条积分流水（`reason='redemption'`，`delta=-应付总额`，
//      `balanceAfter=扣减后余额`），维系「余额 = 流水累积」（需求 10.2、20.2）。
//   4. 移除购物车已兑项：结算（来自购物车）时移除本次兑换的购物车条目（需求 7.5）；
//      立即兑换不来自购物车，故由 `removeRedeemedCartItems=false` 关闭，避免误删。
//   5. 低库存提醒：对**扣减后库存恰为 0** 的商品，经注入的 {@link LowStockAlerter}
//      触发一条去重的低库存提醒（库存降为 0 是唯一触发点，需求 5.3；去重由 AlertService
//      任务 12.3 保证）。提醒写入复用本事务句柄（{@link RedemptionTx.handle}），与兑换
//      同成败。
//
// 依赖可注入（{@link RedemptionEffectsDependencies}）：低库存提醒器由外部装配（默认
// 生产使用 AlertService），测试注入替身以脱离真实数据库验证 Property 25 相关行为。
//
// Requirements: 7.5, 9.2, 5.3. Design: 兑换事务序列图, Property 14/15/25.
import { OrderType } from '../lib/domain';
import { splitOrdersByType } from './redemption-split';
/**
 * 构建可注入 {@link RedemptionHooks.applyEffects} 的兑换副作用钩子（任务 8.9）。
 *
 * 返回的钩子在兑换事务内（积分/库存扣减之后）执行拆单落库、虚拟 CDK 消耗、积分
 * 流水、购物车清理与低库存提醒；任一步抛错随事务整体回滚。
 */
export function buildRedemptionApplyEffects(deps) {
    const removeRedeemedCartItems = deps.removeRedeemedCartItems ?? true;
    return async (ctx, tx) => {
        // 1) 按类型拆单并落库（订单 + 订单项）；2) 虚拟订单消耗 CDK（需求 7.9、9.2）。
        const drafts = splitOrdersByType(ctx.lines);
        for (const draft of drafts) {
            const orderId = await tx.insertOrder({
                userId: ctx.userId,
                type: draft.type,
                pointsSpent: draft.pointsSpent,
                // 仅实物订单持久化配送地址（需求 8.1）；虚拟订单无需地址（需求 9.1）。
                shippingAddress: draft.type === OrderType.Physical ? (ctx.address ?? null) : null,
            });
            await tx.insertOrderItems(orderId, draft.items.map((item) => ({
                productId: item.productId,
                productName: item.name,
                quantity: item.quantity,
                unitPoints: item.unitPoints,
            })));
            if (draft.type === OrderType.Virtual) {
                for (const item of draft.items) {
                    // 每虚拟单位消耗 1 个可用 CDK 并关联本订单（需求 9.2）。
                    await tx.consumeCdks(item.productId, item.quantity, orderId);
                }
            }
        }
        // 3) 记一条积分流水：余额 = 流水累积（需求 10.2、20.2）。
        await tx.insertPointsLedger({
            userId: ctx.userId,
            delta: -ctx.totalCost,
            reason: 'redemption',
            balanceAfter: ctx.account.balance - ctx.totalCost,
        });
        // 4) 移除购物车已兑项（仅来自购物车的结算，需求 7.5）。
        if (removeRedeemedCartItems) {
            await tx.removeCartItems(ctx.userId, ctx.lines.map((line) => line.productId));
        }
        // 5) 对扣减后库存恰为 0 的商品触发去重低库存提醒（需求 5.3）。
        //    ctx.lines 携带锁定时（扣减前）库存，故扣减后库存 = stock - quantity。
        for (const line of ctx.lines) {
            if (line.product.stock - line.quantity === 0) {
                await deps.alertService.triggerLowStock(line.productId, tx.handle);
            }
        }
    };
}
