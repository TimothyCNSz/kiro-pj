// 混合兑换按类型拆单（需求 7.9）—— 纯函数拆分逻辑。
//
// 需求 7.9：一次结算同时包含实物商品与虚拟商品时，系统 SHALL 按商品类型拆分生成
// 独立的实物订单与虚拟订单，分别进入各自的发货流程。本模块只承担**纯粹的拆分计
// 算**：把已锁定并校验后的兑换明细（{@link RedemptionLine}）按商品类型
// （`physical` / `virtual`）划分为至多两份订单草稿（{@link OrderDraft}），每份草稿
// 携带其归类后的订单项与该订单消耗积分（`pointsSpent`）。
//
// 关键不变式（对应设计 Property 15「混合兑换按类型拆分且积分守恒」）：
//   - 每个订单项按其商品类型正确归类（实物项只落入实物订单，虚拟项只落入虚拟订单）；
//   - 拆分后各订单 `pointsSpent` 之和 **恒等于** 本次兑换应付总额
//     （Σ pointsSpent === totalCost，积分守恒）；
//   - 仅为实际出现的类型生成草稿（纯实物 → 1 份实物；纯虚拟 → 1 份虚拟；
//     混合 → 2 份；空明细 → 0 份）。
//
// 本模块**不做任何数据库写入**。它是任务 8.9 在 `RedemptionHooks.applyEffects`
// 事务内 INSERT 实际订单/订单项时所复用的拆分算子（见 redemption-service.ts 的
// 扩展接缝）。
//
// Requirements: 7.9. Design: Property 15.
import { OrderType, ProductType } from '../lib/domain';
/** 商品类型 → 订单类型的映射（两者取值一一对应，此处显式转换以解耦领域枚举）。 */
const PRODUCT_TYPE_TO_ORDER_TYPE = {
    [ProductType.Physical]: OrderType.Physical,
    [ProductType.Virtual]: OrderType.Virtual,
};
// 草稿输出顺序固定为「实物在前、虚拟在后」，使结果稳定、便于测试与展示。
const ORDER_TYPE_OUTPUT_ORDER = [OrderType.Physical, OrderType.Virtual];
/**
 * 按商品类型将兑换明细拆分为至多两份订单草稿（需求 7.9）。
 *
 * 拆分规则：
 *   - 每个 {@link RedemptionLine} 依据其 `product.type` 归入对应类型的订单草稿；
 *   - 每份草稿的 `pointsSpent` 为其订单项应付积分之和（各行 `cost = 单价 × 数量`）；
 *   - 只为实际出现的类型生成草稿，因此返回长度为 0（空明细）、1（单一类型）
 *     或 2（同含实物与虚拟）。
 *
 * 积分守恒（Property 15）：由于每一行恰好落入且仅落入一份草稿，且 `pointsSpent`
 * 逐行累加自 `line.cost`，故 Σ(各草稿 pointsSpent) 恒等于 Σ(各行 cost) = 应付总额。
 *
 * @param lines 已锁定并校验后的兑换明细（顺序不影响结果的正确性与积分守恒）。
 * @returns 订单草稿数组，按「实物、虚拟」顺序排列，仅含实际出现的类型。
 */
export function splitOrdersByType(lines) {
    // 以订单类型分组累积；使用 Map 保证同类型明细合并进同一份草稿。
    const draftsByType = new Map();
    for (const line of lines) {
        const orderType = PRODUCT_TYPE_TO_ORDER_TYPE[line.product.type];
        let draft = draftsByType.get(orderType);
        if (draft === undefined) {
            draft = { type: orderType, pointsSpent: 0, items: [] };
            draftsByType.set(orderType, draft);
        }
        draft.items.push({
            productId: line.productId,
            name: line.product.name,
            quantity: line.quantity,
            unitPoints: line.product.pointsCost,
        });
        // 逐行累加 line.cost（= unitPoints × quantity）——积分守恒的来源。
        draft.pointsSpent += line.cost;
    }
    // 以固定顺序输出，仅保留实际出现的类型（0 / 1 / 2 份）。
    return ORDER_TYPE_OUTPUT_ORDER.flatMap((type) => {
        const draft = draftsByType.get(type);
        return draft ? [draft] : [];
    });
}
