// StockGuard — 库存强约束的可复用纯逻辑（需求 5.2, 6.3）。
//
// 集中承载「零库存禁止加购/兑换」与「数量超库存阻止结算」两条库存强约束的判定，
// 抽象为无副作用的纯函数，便于被购物车（CartService，任务 7.3）与兑换前置校验
// （RedemptionService，任务 8.4）复用，并可脱离数据库独立进行属性化测试
// （Property 11，任务 7.4）。
//
// 判定口径（对齐设计「库存与积分校验」需求 5.2、需求 6.3）：
//   - 可兑换库存为 0 的商品视为「已兑完」，请求任何数量均非法（禁止加购/立即兑换）。
//   - 请求数量 > 可兑换库存时非法（购物车超库存阻止结算并提示库存不足）。
// 库存来源的差异（虚拟商品 = 可用 CDK 数、实物商品 = stock 字段）由上游
// {@link StockResolver} 负责解析后传入本模块，本模块只做数量与可用量的比较。
//
// 非法情形统一以 `INSUFFICIENT_STOCK` 拒绝（见 {@link ErrorCode.InsufficientStock}）。
//
// Requirements: 5.2, 6.3.
import { ErrorCode } from '../lib/errors';
import { HttpError } from '../middleware/http-error';
/**
 * 纯谓词：请求数量是否落在可兑换库存内（且库存 > 0）。
 *
 * 可兑换库存 ≤ 0（已兑完）时恒为 `false`（需求 5.2）；否则要求
 * `requestedQuantity <= availableStock`（需求 6.3）。无副作用。
 */
export function isWithinStock(requestedQuantity, availableStock) {
    return availableStock > 0 && requestedQuantity <= availableStock;
}
/**
 * 纯函数：收集全部违反库存约束的条目（已兑完或请求超库存）。
 * 空数组表示全部合法。用于结算前一次性校验购物车所有条目（需求 6.3）。
 */
export function findStockViolations(items) {
    return items.filter((item) => !isWithinStock(item.requestedQuantity, item.availableStock));
}
/** 生成某违规条目的库存不足 / 已兑完提示文案（需求 5.2, 6.3）。 */
export function stockViolationMessage(item) {
    const label = item.name ?? item.productId;
    if (item.availableStock <= 0) {
        return `商品「${label}」已兑完，无法加入购物车或兑换`;
    }
    return `商品「${label}」库存不足，仅剩 ${item.availableStock} 件，无法按 ${item.requestedQuantity} 件兑换`;
}
/**
 * 断言全部条目均在库存内，否则以 `INSUFFICIENT_STOCK` 拒绝并提示首个违规商品。
 *
 * 供加购/改量（单条目）与结算（多条目）复用；无副作用（不改动任何库存/积分），
 * 符合「阻止兑换且不产生副作用」的前置校验语义（需求 5.2, 6.3）。
 *
 * @throws HttpError(INSUFFICIENT_STOCK) 存在已兑完或超库存的条目。
 */
export function assertWithinStock(items) {
    const violations = findStockViolations(items);
    if (violations.length > 0) {
        throw new HttpError(ErrorCode.InsufficientStock, stockViolationMessage(violations[0]));
    }
}
