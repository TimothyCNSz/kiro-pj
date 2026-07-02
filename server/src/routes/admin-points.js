// 管理端积分管理路由（需求 13.1–13.6；见设计「后端 API 契约」管理-积分分组）。
//
// 挂载端点（相对本 Router；在全局前缀 + `/admin/points` 之下）：
//   - POST /adjust        需管理员：对单个员工发放/扣除积分；扣除会使余额变负则拒绝并
//                         提示余额不足（需求 13.1, 13.3, 13.5, 13.6）。
//   - POST /batch-adjust  需管理员：对多个员工批量发放/扣除积分，跳过会变负者、其余执行
//                         （部分成功），每位实际执行者记一条操作日志（需求 13.2, 13.4, 13.6）。
//
// 端点仅负责传输编解码与统一响应信封，业务逻辑委托给可注入的 {@link PointsService}；访问
// 先经认证中间件，再经 `adminGuard`（未登录先于越权：401 优先于 403，需求 3.3, 20.4）。
// 操作人（管理员 actor）取自 `req.user.userId`（经认证中间件填充）。服务层以携带
// `ErrorCode` 的 `HttpError` 上抛（余额不足 / 校验失败），交由统一错误中间件序列化。
//
// 安全：本路由从不接受客户端指定「目标余额」，只接受相对变化量 delta，经受控服务改变
// 余额（需求 20.2）。
//
// Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 3.3, 20.4.
import { Router } from 'express';
import { success } from '../lib/api';
import { ErrorCode } from '../lib/errors';
import { adminGuard, createAuthMiddleware } from '../middleware/auth';
import { HttpError } from '../middleware/http-error';
import { PointsService, } from '../services/points-service';
/** 单个积分调整成功提示。 */
export const ADJUST_OK_MESSAGE = '积分调整成功';
/** 批量积分调整完成提示。 */
export const BATCH_ADJUST_OK_MESSAGE = '批量积分调整完成';
/** 包裹异步处理器，将 rejection 转交 Express 错误中间件。 */
const asyncHandler = (fn) => (req, res, next) => {
    fn(req, res).catch(next);
};
/** 取当前登录管理员 id（操作人）；缺失（未认证）以 401 拒绝——一般不会发生（已挂认证中间件）。 */
function requireAdminId(req) {
    const adminId = req.user?.userId;
    if (!adminId) {
        throw new HttpError(ErrorCode.Unauthenticated, '未登录或会话已过期，请重新登录');
    }
    return adminId;
}
/** 从请求体安全取非空字符串 userId，否则 422。 */
function requireUserId(value) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new HttpError(ErrorCode.Validation, '缺少有效的员工 id');
    }
    return value;
}
/** 从请求体安全取整数 delta（积分变化量），否则 422。 */
function requireDelta(value) {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new HttpError(ErrorCode.Validation, '积分变更量必须为整数');
    }
    return value;
}
/** 从请求体安全取非空字符串数组 userIds，否则 422。 */
function requireUserIds(value) {
    if (!Array.isArray(value) || value.length === 0) {
        throw new HttpError(ErrorCode.Validation, '请至少选择一位员工');
    }
    return value.map((v) => requireUserId(v));
}
/** 从请求体安全取可选备注（需求 13.5）；非字符串视为未提供。 */
function extractNote(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
/**
 * 创建 `/admin/points` 路由（POST /adjust、POST /batch-adjust）。
 * 每个端点先经认证中间件再经 `adminGuard`（需求 3.3, 20.4：员工访问返回 403）。
 */
export function createAdminPointsRouter(deps) {
    const router = Router();
    // 单个发放/扣除（需求 13.1, 13.3, 13.5, 13.6）。
    router.post('/adjust', deps.authMiddleware, adminGuard, asyncHandler(async (req, res) => {
        const adminId = requireAdminId(req);
        const body = (req.body ?? {});
        const userId = requireUserId(body.userId);
        const delta = requireDelta(body.delta);
        const note = extractNote(body.note);
        const account = await deps.pointsService.adjust(adminId, userId, delta, note);
        res.json(success(account, ADJUST_OK_MESSAGE));
    }));
    // 批量发放/扣除（部分成功，需求 13.2, 13.4, 13.6）。
    router.post('/batch-adjust', deps.authMiddleware, adminGuard, asyncHandler(async (req, res) => {
        const adminId = requireAdminId(req);
        const body = (req.body ?? {});
        const userIds = requireUserIds(body.userIds);
        const delta = requireDelta(body.delta);
        const note = extractNote(body.note);
        const result = await deps.pointsService.batchAdjust(adminId, userIds, delta, note);
        res.json(success(result, BATCH_ADJUST_OK_MESSAGE));
    }));
    return router;
}
/**
 * 构造生产默认 `/admin/points` 路由：默认 PointsService（Drizzle 仓储 + LogService）
 * + 基于 `JWT_SECRET` 的认证中间件。构造无副作用（数据库连接惰性建立）。
 */
export function buildDefaultAdminPointsRouter() {
    return createAdminPointsRouter({
        pointsService: new PointsService(),
        authMiddleware: createAuthMiddleware(),
    });
}
