// 管理端发货路由（需求 8.2, 8.3, 9.3, 9.4, 14.1, 14.2, 14.3, 14.4；见设计「后端 API 契约 · 管理-发货」）。
//
// 挂载端点（相对本 Router；在全局前缀 + `/admin/orders` 之下），全部经认证中间件 +
// 管理员 Guard（未登录先于越权：401 优先于 403，需求 3.3, 3.4, 20.4）：
//   - POST /:id/ship-physical  需管理员：为实物订单上传物流编号（非空校验，14.3）；
//                              记录编号并置「已发货」（8.2, 14.1）；回显假数据物流明细（8.3）。
//                              入参 `{ trackingNo: string }`。
//   - POST /:id/ship-virtual   需管理员：为虚拟订单完成虚拟发货，关联并交付 CDK 并置
//                              「已发货」（9.4, 14.2）。无请求体。
//
// 端点仅负责传输编解码与统一响应信封，业务逻辑委托给可注入的 {@link FulfillmentCommandService}；
// 失败一律以携带 `ErrorCode` 的 `HttpError` 上抛，交由统一错误中间件序列化；订单不存在
// （服务返回 null）以通用 404 信封返回。
//
// Requirements: 8.2, 8.3, 9.3, 9.4, 14.1, 14.2, 14.3, 14.4.
import { Router } from 'express';
import { success } from '../lib/api';
import { adminGuard, createAuthMiddleware } from '../middleware/auth';
import { NOT_FOUND_CODE } from '../middleware/error-handler';
import { FulfillmentService, } from '../services/fulfillment-service';
/** 实物发货成功提示。 */
export const SHIP_PHYSICAL_OK_MESSAGE = '实物订单已发货';
/** 虚拟发货成功提示。 */
export const SHIP_VIRTUAL_OK_MESSAGE = '虚拟订单已发货';
/** 订单不存在提示（无对应领域错误码，用通用 404 信封）。 */
export const ORDER_NOT_FOUND_MESSAGE = '订单不存在';
/** 通用 404 信封（订单不存在，无对应领域错误码）。 */
const notFoundEnvelope = (message) => ({
    code: NOT_FOUND_CODE,
    message,
    data: null,
});
/** 包裹异步处理器，将 rejection 转交 Express 错误中间件。 */
const asyncHandler = (fn) => (req, res, next) => {
    fn(req, res).catch(next);
};
/**
 * 创建 `/admin/orders` 发货子路由（`POST /:id/ship-physical`、`POST /:id/ship-virtual`）。
 * 每个端点先经认证中间件再经 `adminGuard`（需求 3.3, 3.4, 20.4）。
 */
export function createAdminFulfillmentRouter(deps) {
    const router = Router();
    // 实物发货（需求 8.2, 8.3, 14.1, 14.3）。
    router.post('/:id/ship-physical', deps.authMiddleware, adminGuard, asyncHandler(async (req, res) => {
        const adminId = req.user.userId;
        const trackingNo = req.body?.trackingNo;
        const result = await deps.fulfillmentService.shipPhysical(adminId, req.params.id, trackingNo);
        if (!result) {
            res.status(404).json(notFoundEnvelope(ORDER_NOT_FOUND_MESSAGE));
            return;
        }
        res.json(success(result, SHIP_PHYSICAL_OK_MESSAGE));
    }));
    // 虚拟发货（需求 9.3, 9.4, 14.2）。
    router.post('/:id/ship-virtual', deps.authMiddleware, adminGuard, asyncHandler(async (req, res) => {
        const adminId = req.user.userId;
        const result = await deps.fulfillmentService.shipVirtual(adminId, req.params.id);
        if (!result) {
            res.status(404).json(notFoundEnvelope(ORDER_NOT_FOUND_MESSAGE));
            return;
        }
        res.json(success(result, SHIP_VIRTUAL_OK_MESSAGE));
    }));
    return router;
}
/**
 * 构造生产默认发货路由：Drizzle 持久化 + 基于 `JWT_SECRET` 的认证中间件。
 * 所有默认实现构造均无副作用（数据库连接惰性建立）。
 */
export function buildDefaultAdminFulfillmentRouter() {
    return createAdminFulfillmentRouter({
        fulfillmentService: new FulfillmentService(),
        authMiddleware: createAuthMiddleware(),
    });
}
