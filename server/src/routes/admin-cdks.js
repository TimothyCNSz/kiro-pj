// 管理端 CDK 维护路由（需求 12.2, 5.1；见设计「后端 API 契约」管理-商品分组）。
//
// 挂载端点（相对本 Router；在全局前缀 + `/admin/products` 之下）：
//   - POST /:id/cdks  需管理员：为虚拟商品追加用于虚拟发货的 CDK（12.2, 5.1）。
//                     入参 `{ codes: string[] }`；返回本次新增数量与更新后可用
//                     CDK 库存。
//
// 端点仅负责传输编解码与统一响应信封，业务逻辑委托给可注入的 {@link CdkService}；
// 失败一律以携带 `ErrorCode` 的 `HttpError` 上抛，交由统一错误中间件序列化。
// 访问先经认证中间件，再经 `adminGuard`（未登录先于越权：401 优先于 403）。
//
// Requirements: 5.1, 12.2.
import { Router } from 'express';
import { success } from '../lib/api';
import { adminGuard, createAuthMiddleware } from '../middleware/auth';
import { CdkService } from '../services/cdk-service';
/** 新增 CDK 成功提示。 */
export const ADD_CDKS_OK_MESSAGE = 'CDK 兑换码已添加';
/** 包裹异步处理器，将 rejection 转交 Express 错误中间件。 */
const asyncHandler = (fn) => (req, res, next) => {
    fn(req, res).catch(next);
};
/**
 * 创建 `/admin/products` CDK 子路由（当前仅 `POST /:id/cdks`）。
 * 每个端点先经认证中间件再经 `adminGuard`（需求 3.3, 3.4, 20.4）。
 */
export function createAdminCdksRouter(deps) {
    const router = Router();
    router.post('/:id/cdks', deps.authMiddleware, adminGuard, asyncHandler(async (req, res) => {
        const productId = req.params.id;
        const codes = req.body?.codes;
        const result = await deps.cdkService.addCdks(productId, codes);
        res.status(201).json(success(result, ADD_CDKS_OK_MESSAGE));
    }));
    return router;
}
/**
 * 构造生产默认 CDK 维护路由：Drizzle 持久化 + 基于 `JWT_SECRET` 的认证中间件。
 * 所有默认实现构造均无副作用（数据库连接惰性建立）。
 */
export function buildDefaultAdminCdksRouter() {
    return createAdminCdksRouter({
        cdkService: new CdkService(),
        authMiddleware: createAuthMiddleware(),
    });
}
