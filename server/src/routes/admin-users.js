// 管理端员工列表路由（需求 24.1, 24.2, 24.3, 24.4, 24.5, 24.6；见设计「后端 API 契约」
// 管理-员工分组）。
//
// 挂载端点（相对本 Router；在全局前缀 + `/admin/users` 之下）：
//   - GET /?q=&page=  需管理员：按邮箱关键字（大小写不敏感）过滤 + 分页返回员工列表，
//                     每项含 userId/email/role/status/balance（需求 24.1, 24.2, 24.4）。
//                     无匹配返回空 `list`，前端据此展示「未找到相关员工」（需求 24.3）；
//                     结果供积分发放/扣除流程选择目标（需求 24.5）。
//
// 端点仅负责传输编解码与统一响应信封，业务逻辑委托给可注入的 AdminUserService；访问先经
// 认证中间件，再经 `adminGuard`（未登录先于越权：401 优先于 403，需求 24.6）。
//
// Requirements: 24.1, 24.2, 24.3, 24.4, 24.5, 24.6.
import { Router } from 'express';
import { paginated } from '../lib/api';
import { adminGuard, createAuthMiddleware } from '../middleware/auth';
import { AdminUserService, DrizzleAdminUserRepository, } from '../services/admin-user-service';
/** 员工列表成功提示。 */
export const LIST_USERS_OK_MESSAGE = '员工列表';
/** 分页默认与上限（演示级）。 */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
/** 从查询参数安全解析分页（非法/缺省回退默认，pageSize 限幅）。 */
export function parsePagination(query) {
    const rawPage = Number(query.page);
    const rawSize = Number(query.pageSize);
    const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
    const pageSize = Number.isFinite(rawSize) && rawSize >= 1
        ? Math.min(Math.floor(rawSize), MAX_PAGE_SIZE)
        : DEFAULT_PAGE_SIZE;
    return { page, pageSize };
}
/** 安全地将未知输入取为字符串（非字符串回退空串）。 */
const asString = (v) => (typeof v === 'string' ? v : '');
/** 包裹异步处理器，将 rejection 转交 Express 错误中间件。 */
const asyncHandler = (fn) => (req, res, next) => {
    fn(req, res).catch(next);
};
/**
 * 创建 `/admin/users` 路由（当前仅 `GET /`）。
 * 每个端点先经认证中间件再经 `adminGuard`（需求 24.6：员工访问返回 403）。
 */
export function createAdminUsersRouter(deps) {
    const router = Router();
    router.get('/', deps.authMiddleware, adminGuard, asyncHandler(async (req, res) => {
        const q = asString(req.query.q);
        const { page, pageSize } = parsePagination(req.query);
        const result = await deps.adminUserService.listUsers({ q, page, pageSize });
        res.json(paginated(result.list, { total: result.total, page: result.page, pageSize: result.pageSize }, LIST_USERS_OK_MESSAGE));
    }));
    return router;
}
/**
 * 构造生产默认 `/admin/users` 路由：Drizzle 员工仓储 + 基于 `JWT_SECRET` 的认证中间件。
 * 构造无副作用（数据库连接惰性建立）。
 */
export function buildDefaultAdminUsersRouter() {
    return createAdminUsersRouter({
        adminUserService: new AdminUserService({ repository: new DrizzleAdminUserRepository() }),
        authMiddleware: createAuthMiddleware(),
    });
}
