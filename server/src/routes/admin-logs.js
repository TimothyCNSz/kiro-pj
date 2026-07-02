// 管理端操作日志路由（需求 16.1, 16.2, 14.4；见设计「后端 API 契约」管理-日志分组）。
//
// 挂载端点（相对本 Router；在全局前缀 + `/admin/logs` 之下）：
//   - GET /?page=  需管理员：按操作时间从新到旧分页返回操作日志（需求 16.2）。
//                  日志由商品/积分/发货等管理操作写入（需求 16.1, 14.4；见 LogService）。
//
// 端点仅负责传输编解码与统一响应信封，业务逻辑委托给可注入的 LogService；访问先经
// 认证中间件，再经 `adminGuard`（未登录先于越权：401 优先于 403）。
//
// Requirements: 16.1, 16.2, 14.4.
import { Router } from 'express';
import { paginated } from '../lib/api';
import { adminGuard, createAuthMiddleware } from '../middleware/auth';
import { LogService } from '../services/log-service';
import { parsePagination } from './products';
/** 操作日志列表成功提示。 */
export const LIST_LOGS_OK_MESSAGE = '操作日志列表';
/** 包裹异步处理器，将 rejection 转交 Express 错误中间件。 */
const asyncHandler = (fn) => (req, res, next) => {
    fn(req, res).catch(next);
};
/**
 * 创建 `/admin/logs` 路由（当前仅 `GET /`）。
 * 每个端点先经认证中间件再经 `adminGuard`（需求 3.3, 3.4, 20.4）。
 */
export function createAdminLogsRouter(deps) {
    const router = Router();
    router.get('/', deps.authMiddleware, adminGuard, asyncHandler(async (req, res) => {
        const pagination = parsePagination(req.query);
        const result = await deps.logService.listLogs(pagination);
        res.json(paginated(result.list, { total: result.total, page: result.page, pageSize: result.pageSize }, LIST_LOGS_OK_MESSAGE));
    }));
    return router;
}
/**
 * 构造生产默认操作日志路由：Drizzle 持久化 + 基于 `JWT_SECRET` 的认证中间件。
 * 所有默认实现构造均无副作用（数据库连接惰性建立）。
 */
export function buildDefaultAdminLogsRouter() {
    return createAdminLogsRouter({
        logService: new LogService(),
        authMiddleware: createAuthMiddleware(),
    });
}
