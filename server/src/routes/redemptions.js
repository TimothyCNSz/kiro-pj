// /redemptions 路由（需求 7.1, 7.2, 7.3, 7.4, 7.5, 7.8, 7.9, 9.2, 5.3；见设计
// 「后端 API 契约」兑换分组）。
//
// 挂载以下端点（相对本 Router，最终位于全局前缀 + `/redemptions` 之下）：
//   - POST /redemptions/checkout   购物车结算（汇总当前员工购物车条目，可含配送地址）。
//                                  需求 7.1, 7.3, 7.4, 7.5, 7.8, 7.9。
//   - POST /redemptions/instant    立即兑换单件商品（可含配送地址）。需求 7.2, 7.4, 7.8。
//
// 两端点均需登录（需求 1.15）：整个路由挂在认证中间件之后，`req.user.userId` 作为
// 兑换发起人。端点仅负责传输编解码与统一响应信封，兑换事务核心与副作用委托给可注入的
// {@link RedemptionExecutor}（由 RedemptionService 组合 preValidate(8.4) + applyEffects(8.9)
// 构成）。服务层以携带 `ErrorCode` 的 `HttpError` 上抛（积分不足 / 库存不足 / 缺地址 /
// 并发冲突等），交由统一错误中间件序列化为对应 HTTP 状态（错误码 → HTTP 映射见 errors.ts）。
//
// 结算与立即兑换使用**不同**的兑换执行器：结算来自购物车，成功后移除已兑购物车条目
// （需求 7.5）；立即兑换不来自购物车，不清理购物车。二者的差异封装在各自的
// applyEffects 中（见 buildDefaultRedemptionsRouter）。
//
// Requirements: 1.15, 7.1, 7.2, 7.3, 7.4, 7.5, 7.8, 7.9, 9.2, 5.3.
import { Router } from 'express';
import { success } from '../lib/api';
import { ErrorCode } from '../lib/errors';
import { createAuthMiddleware } from '../middleware/auth';
import { HttpError } from '../middleware/http-error';
import { AlertService } from '../services/alert-service';
import { CartService, DrizzleCartRepository, } from '../services/cart-service';
import { buildRedemptionApplyEffects } from '../services/redemption-effects';
import { DrizzleRedemptionStore, RedemptionService, } from '../services/redemption-service';
import { buildRedemptionPreValidate } from '../services/redemption-validation';
/** 包裹异步处理器，将 rejection 转交 Express 错误中间件。 */
const asyncHandler = (fn) => (req, res, next) => {
    fn(req, res).catch(next);
};
/** 取当前登录用户 id；缺失（未认证）以 401 拒绝——一般不会发生（已挂认证中间件）。 */
function requireUserId(req) {
    const userId = req.user?.userId;
    if (!userId) {
        throw new HttpError(ErrorCode.Unauthenticated, '未登录或会话已过期，请重新登录');
    }
    return userId;
}
/** 从请求体安全取 productId（非空字符串），否则 422。 */
function requireProductId(value) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new HttpError(ErrorCode.Validation, '缺少商品 id');
    }
    return value;
}
/**
 * 规整立即兑换数量：缺省为 1；提供时必须为 >= 1 的整数，否则 422。
 * （更严格的库存/积分校验由兑换事务核心负责。）
 */
function normalizeInstantQuantity(value) {
    if (value === undefined || value === null)
        return 1;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new HttpError(ErrorCode.Validation, '兑换数量必须为不小于 1 的整数');
    }
    return value;
}
/** 从请求体安全取可选配送地址（透传给事务核心，由 preValidate 校验完整性）。 */
function extractAddress(value) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'object') {
        throw new HttpError(ErrorCode.Validation, '配送地址格式不正确');
    }
    return value;
}
/** 将兑换事务结果映射为面向前端的响应摘要。 */
function toRedemptionResponse(result) {
    return {
        totalCost: result.totalCost,
        balanceBefore: result.balanceBefore,
        balanceAfter: result.balanceAfter,
        items: result.lines.map((line) => ({
            productId: line.productId,
            name: line.product.name,
            type: line.product.type,
            quantity: line.quantity,
            unitPoints: line.product.pointsCost,
            cost: line.cost,
        })),
    };
}
/**
 * 创建 `/redemptions` 路由。全部端点经 `deps.authMiddleware` 保护（需求 1.15）。
 */
export function createRedemptionsRouter(deps) {
    const router = Router();
    router.use(deps.authMiddleware);
    // 购物车结算（需求 7.1, 7.3, 7.4, 7.5, 7.8, 7.9）。
    router.post('/checkout', asyncHandler(async (req, res) => {
        const userId = requireUserId(req);
        const body = (req.body ?? {});
        const address = extractAddress(body.address);
        // 汇总当前员工购物车条目作为兑换项（需求 7.1）。
        const cart = await deps.cartReader.getCart(userId);
        const items = cart.items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
        }));
        const result = await deps.checkoutService.checkout(userId, items, { address });
        res.status(201).json(success(toRedemptionResponse(result)));
    }));
    // 立即兑换单件商品（需求 7.2, 7.4, 7.8）。
    router.post('/instant', asyncHandler(async (req, res) => {
        const userId = requireUserId(req);
        const body = (req.body ?? {});
        const productId = requireProductId(body.productId);
        const quantity = normalizeInstantQuantity(body.quantity);
        const address = extractAddress(body.address);
        const result = await deps.instantService.checkout(userId, [{ productId, quantity }], {
            address,
        });
        res.status(201).json(success(toRedemptionResponse(result)));
    }));
    return router;
}
/**
 * 构造生产默认 `/redemptions` 路由：Drizzle 事务存储 + 前置校验(8.4) + 副作用(8.9)。
 *
 * 结算与立即兑换共享事务核心与前置校验，但使用**不同**的副作用钩子：结算移除已兑
 * 购物车条目（需求 7.5），立即兑换不清理购物车。低库存提醒去重写入由 AlertService
 * （任务 12.3）提供并参与兑换事务。构造无副作用（数据库连接惰性建立）。
 */
export function buildDefaultRedemptionsRouter(overrides = {}) {
    const store = new DrizzleRedemptionStore();
    const preValidate = buildRedemptionPreValidate();
    const alertService = new AlertService();
    const checkoutService = new RedemptionService({
        store,
        hooks: {
            preValidate,
            applyEffects: buildRedemptionApplyEffects({ alertService, removeRedeemedCartItems: true }),
        },
    });
    const instantService = new RedemptionService({
        store,
        hooks: {
            preValidate,
            applyEffects: buildRedemptionApplyEffects({ alertService, removeRedeemedCartItems: false }),
        },
    });
    const cartReader = new CartService({
        repository: overrides.cart?.repository ?? new DrizzleCartRepository(),
    });
    const authMiddleware = createAuthMiddleware();
    return createRedemptionsRouter({ checkoutService, instantService, cartReader, authMiddleware });
}
