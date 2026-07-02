// 管理端低库存提醒路由（需求 15.1, 15.2；见设计「后端 API 契约」管理-提醒分组）。
//
// 挂载端点（相对本 Router；在全局前缀 + `/admin/alerts` 之下）：
//   - GET /low-stock  需管理员：返回当前（未解除）低库存提醒列表，供后台 Dashboard
//                     展示（需求 15.2）。提醒由兑换事务在库存降为 0 时去重写入
//                     （需求 5.3, 15.1；见 AlertService）。
//
// 端点仅负责传输编解码与统一响应信封，业务逻辑委托给可注入的 AlertService；访问先经
// 认证中间件，再经 `adminGuard`（未登录先于越权：401 优先于 403）。
//
// Requirements: 15.1, 15.2.
import { Router } from 'express';
import { success } from '../lib/api';
import { adminGuard, createAuthMiddleware } from '../middleware/auth';
import { AlertService } from '../services/alert-service';
/** 低库存提醒列表成功提示。 */
export const LIST_LOW_STOCK_OK_MESSAGE = '低库存提醒列表';
/** 包裹异步处理器，将 rejection 转交 Express 错误中间件。 */
const asyncHandler = (fn) => (req, res, next) => {
    fn(req, res).catch(next);
};
/**
 * 创建 `/admin/alerts` 路由（当前仅 `GET /low-stock`）。
 * 每个端点先经认证中间件再经 `adminGuard`（需求 3.3, 3.4, 20.4）。
 */
export function createAdminAlertsRouter(deps) {
    const router = Router();
    router.get('/low-stock', deps.authMiddleware, adminGuard, asyncHandler(async (_req, res) => {
        const alerts = await deps.alertService.listLowStock();
        res.json(success(alerts, LIST_LOW_STOCK_OK_MESSAGE));
    }));
    return router;
}
/**
 * 构造生产默认低库存提醒路由：Drizzle 持久化 + 基于 `JWT_SECRET` 的认证中间件。
 * 所有默认实现构造均无副作用（数据库连接惰性建立）。
 */
export function buildDefaultAdminAlertsRouter() {
    return createAdminAlertsRouter({
        alertService: new AlertService(),
        authMiddleware: createAuthMiddleware(),
    });
}
