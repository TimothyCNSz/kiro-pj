// RedemptionValidation — 兑换前置校验（无副作用，需求 5.4, 5.5, 6.3, 7.3）。
//
// 本模块提供兑换事务的**前置校验**逻辑，经 {@link RedemptionHooks.preValidate}
// 接缝在 RedemptionService 的任何库存/积分扣减之前运行（见 redemption-service.ts
// 的「扩展接缝」说明）。校验**无任何副作用**：只读取 {@link RedemptionContext}
// 中的账户余额、锁定商品行与地址，不修改余额/库存/CDK/订单集合，任一条件不满足即
// throw（在事务内即整体回滚，保证 Property 13「阻止非法兑换且不产生副作用」）。
//
// 三条前置约束（对齐设计「兑换事务」序列图与错误响应表）：
//   (a) 含实物商品但缺配送地址（或地址不完整）→ ADDRESS_REQUIRED（需求 7.3）。
//   (b) 可用积分 < 应付总额 → INSUFFICIENT_POINTS（需求 5.4）。
//   (c) 任一商品请求数量 > 其当前库存（含已兑完）→ INSUFFICIENT_STOCK（需求 5.5, 6.3）。
//
// 判定复用既有构件：积分复用 {@link assertSufficientPoints}（redemption-service），
// 库存复用 {@link assertWithinStock}（stock-guard），本模块只补充实物地址必填校验，
// 并将三者组合为一个可注入的 preValidate 钩子供任务 8.9 装配。全部函数均为纯函数，
// 便于任务 8.5 的属性化测试（Property 13）直接驱动而无需真实数据库。
//
// Requirements: 5.4, 5.5, 6.3, 7.3.
import { ErrorCode } from '../lib/errors';
import { HttpError } from '../middleware/http-error';
import { ProductType } from '../lib/domain';
import { assertWithinStock } from './stock-guard';
import { assertSufficientPoints, } from './redemption-service';
// ---------------------------------------------------------------------------
// (a) 实物地址必填校验（需求 7.3）
// ---------------------------------------------------------------------------
/**
 * 纯谓词：兑换明细中是否包含实物商品。含实物则确认前必须填写配送地址（需求 7.3）；
 * 纯虚拟兑换无需地址（需求 9.1）。无副作用。
 */
export function containsPhysicalLine(lines) {
    return lines.some((line) => line.product.type === ProductType.Physical);
}
/**
 * 纯谓词：配送地址是否存在且必填字段（收件人 / 电话 / 详细地址）均为非空字符串。
 * 缺失或任一必填字段为空/仅空白视为无效。无副作用。
 */
export function isValidAddress(address) {
    if (address === null || address === undefined || typeof address !== 'object') {
        return false;
    }
    const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
    return nonEmpty(address.recipient) && nonEmpty(address.phone) && nonEmpty(address.detail);
}
/**
 * 断言：若兑换含实物商品，则必须提供有效配送地址，否则以 ADDRESS_REQUIRED 拒绝
 * （需求 7.3）。纯虚拟兑换恒通过（需求 9.1）。只读校验，无副作用。
 *
 * @throws HttpError(ADDRESS_REQUIRED) 含实物商品但缺少有效配送地址。
 */
export function assertAddressForPhysical(ctx) {
    if (containsPhysicalLine(ctx.lines) && !isValidAddress(ctx.address)) {
        throw new HttpError(ErrorCode.AddressRequired, '兑换含实物商品，请先填写配送地址');
    }
}
// ---------------------------------------------------------------------------
// (c) 库存前置校验（需求 5.5, 6.3）——复用 stock-guard
// ---------------------------------------------------------------------------
/** 将兑换明细行映射为 stock-guard 可校验的条目（纯转换，无副作用）。 */
export function toStockCheckItems(lines) {
    return lines.map((line) => ({
        productId: line.productId,
        name: line.product.name,
        requestedQuantity: line.quantity,
        availableStock: line.product.stock,
    }));
}
/**
 * 断言每商品请求数量均不超过其锁定库存（且库存 > 0），否则以 INSUFFICIENT_STOCK
 * 拒绝（复用 {@link assertWithinStock}，需求 5.5, 6.3）。只读校验，无副作用。
 *
 * @throws HttpError(INSUFFICIENT_STOCK) 存在已兑完或超库存的商品。
 */
export function assertLinesWithinStock(lines) {
    assertWithinStock(toStockCheckItems(lines));
}
// ---------------------------------------------------------------------------
// 组合前置校验（无副作用）
// ---------------------------------------------------------------------------
/**
 * 组合前置校验：依次检查 (a) 实物地址、(b) 积分充足、(c) 库存充足，任一不满足即
 * throw（在事务内即整体回滚且无任何扣减，Property 13）。全程只读，无副作用。
 *
 * 检查顺序固定为 地址 → 积分 → 库存，仅影响多重违规时首个抛出的错误码，不影响
 * 「非法兑换必被拒绝」这一整体语义。
 *
 * @throws HttpError(ADDRESS_REQUIRED) 含实物商品但缺有效地址（需求 7.3）。
 * @throws HttpError(INSUFFICIENT_POINTS) 可用积分 < 应付总额（需求 5.4）。
 * @throws HttpError(INSUFFICIENT_STOCK) 任一商品请求数量超库存（需求 5.5, 6.3）。
 */
export function validateRedemption(ctx) {
    assertAddressForPhysical(ctx);
    assertSufficientPoints(ctx.account, ctx.totalCost);
    assertLinesWithinStock(ctx.lines);
}
/**
 * 工厂：构建可注入 {@link RedemptionHooks.preValidate} 的无副作用前置校验钩子。
 * 供任务 8.9 装配进 RedemptionService（`new RedemptionService({ hooks: { preValidate:
 * buildRedemptionPreValidate(), ... } })`），在任何扣减之前拦截非法兑换。
 */
export function buildRedemptionPreValidate() {
    return (ctx) => {
        validateRedemption(ctx);
    };
}
