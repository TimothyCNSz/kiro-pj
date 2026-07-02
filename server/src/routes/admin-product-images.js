// 管理端商品图集路由（需求 12.7, 12.8, 12.9, 22.9, 22.11, 22.12；见设计「后端 API 契约」管理-商品图分组）。
//
// 挂载端点（相对本 Router；在全局前缀 + `/admin/products` 之下），全部经认证中间件
// + 管理员 Guard（需求 3.4, 20.4；未登录先于越权：401 优先于 403）：
//   - POST   /:id/images                    关联已上传图片到图集（≤5 张上限，12.7/22.9/22.11/22.12）。
//   - PATCH  /:id/images/:imageId/primary    将指定图片设为主图（原主图降级，12.8/12.9）。
//   - DELETE /:id/images/:imageId            从图集移除一张图片（12.7）。
//
// 端点仅负责传输编解码与统一响应信封，业务逻辑委托给可注入的 {@link ProductImageService}；
// 图集上限等失败以携带 `ErrorCode` 的 `HttpError` 上抛，交由统一错误中间件序列化；
// 图片不存在以通用 404 信封返回（无对应领域错误码）。
//
// Requirements: 12.7, 12.8, 12.9, 22.9, 22.11, 22.12.
import { Router } from 'express';
import { success } from '../lib/api';
import { NOT_FOUND_CODE } from '../middleware/error-handler';
import { adminGuard, createAuthMiddleware } from '../middleware/auth';
import { ProductImageService } from '../services/product-image-service';
/** 成功提示文案。 */
export const IMAGE_ADDED_MESSAGE = '图片已关联到商品图集';
export const PRIMARY_SET_MESSAGE = '主图已更新';
export const IMAGE_REMOVED_MESSAGE = '图片已从图集移除';
/** 图片不存在提示（无对应领域错误码，用通用 404 信封）。 */
export const IMAGE_NOT_FOUND_MESSAGE = '图片不存在';
/** 通用 404 信封（图片不存在，无对应领域错误码）。 */
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
 * 创建 `/admin/products` 图集子路由。全部端点先经 `deps.authMiddleware` 认证，
 * 再经 `adminGuard` 校验管理员权限（需求 3.4, 20.4）。
 */
export function createAdminProductImagesRouter(deps) {
    const router = Router();
    // 认证 + 管理员 Guard 作用于本 Router 全部端点。
    router.use(deps.authMiddleware, adminGuard);
    // 关联已上传图片到图集（需求 12.7, 22.9, 22.11, 22.12）；超上限由服务抛 IMAGE_LIMIT_EXCEEDED。
    router.post('/:id/images', asyncHandler(async (req, res) => {
        const body = (req.body ?? {});
        const objectKey = body.objectKey;
        const url = body.url;
        const image = await deps.service.addImage(req.params.id, objectKey, url);
        res.status(201).json(success(image, IMAGE_ADDED_MESSAGE));
    }));
    // 设主图（需求 12.8, 12.9）；图片不存在返回 404。
    router.patch('/:id/images/:imageId/primary', asyncHandler(async (req, res) => {
        const ok = await deps.service.setPrimary(req.params.id, req.params.imageId);
        if (!ok) {
            res.status(404).json(notFoundEnvelope(IMAGE_NOT_FOUND_MESSAGE));
            return;
        }
        res.json(success(null, PRIMARY_SET_MESSAGE));
    }));
    // 从图集移除图片（需求 12.7）；图片不存在返回 404。
    router.delete('/:id/images/:imageId', asyncHandler(async (req, res) => {
        const ok = await deps.service.removeImage(req.params.id, req.params.imageId);
        if (!ok) {
            res.status(404).json(notFoundEnvelope(IMAGE_NOT_FOUND_MESSAGE));
            return;
        }
        res.json(success(null, IMAGE_REMOVED_MESSAGE));
    }));
    return router;
}
/**
 * 构造生产默认 `/admin/products` 图集路由：Drizzle 持久化 + 基于 `JWT_SECRET` 的认证中间件。
 * 所有默认实现构造均无副作用（数据库连接惰性建立）。
 */
export function buildDefaultAdminProductImagesRouter() {
    return createAdminProductImagesRouter({
        service: new ProductImageService(),
        authMiddleware: createAuthMiddleware(),
    });
}
