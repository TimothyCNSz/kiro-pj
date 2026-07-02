// /admin/products 路由（需求 12.1, 12.3–12.6, 12.10；见设计「后端 API 契约 · 管理-商品」）。
//
// 挂载以下端点（相对本 Router，最终位于全局前缀 + `/admin/products` 之下），全部经
// 认证中间件 + 管理员 Guard（需求 3.4, 20.4）：
//   - POST   /                 创建商品（12.1）；非负积分/库存校验（12.5）。
//   - PUT    /:id              编辑商品字段（12.3）；不存在返回 404。
//   - PATCH  /:id/status       上/下架状态切换（12.4）；不存在返回 404。
//
// 本阶段刻意不提供 DELETE —— 商品下线通过设为「下架」实现，不做物理删除（需求 12.10）。
//
// 端点仅负责传输编解码与统一响应信封，业务逻辑委托给可注入的 `AdminProductService`；
// 校验失败以携带 `INVALID_PRODUCT_FIELD` 的 `HttpError` 上抛，交由统一错误中间件映射。
//
// Requirements: 12.1, 12.3, 12.4, 12.5, 12.6, 12.10.

import { Router, type Request, type RequestHandler, type Response } from 'express'

import { success, type ApiResponse } from '../lib/api'
import { type ProductStatus, type ProductType } from '../lib/domain'
import { NOT_FOUND_CODE } from '../middleware/error-handler'
import { adminGuard, createAuthMiddleware } from '../middleware/auth'
import {
  AdminProductService,
  type CreateProductInput,
  type UpdateProductPatch,
} from '../services/admin-product-service'

/** 成功提示文案。 */
export const PRODUCT_CREATED_MESSAGE = '商品已创建'
export const PRODUCT_UPDATED_MESSAGE = '商品已更新'
export const PRODUCT_STATUS_UPDATED_MESSAGE = '商品状态已更新'
/** 商品不存在提示（无对应领域错误码，用通用 404 信封）。 */
export const PRODUCT_NOT_FOUND_MESSAGE = '商品不存在'

/** 管理端商品命令服务接口（便于注入替身）。 */
export interface AdminProductCommandService {
  create(input: CreateProductInput): Promise<import('../db/schema').Product>
  update(id: string, patch: UpdateProductPatch): Promise<import('../db/schema').Product | null>
  setStatus(id: string, status: ProductStatus): Promise<import('../db/schema').Product | null>
}

/** `createAdminProductsRouter` 依赖（全部可注入以支持无副作用测试）。 */
export interface AdminProductsRouterDependencies {
  service: AdminProductCommandService
  /** 保护全部端点的认证中间件（其后再挂管理员 Guard）。 */
  authMiddleware: RequestHandler
}

/** 通用 404 信封（商品不存在，无对应领域错误码）。 */
const notFoundEnvelope = (message: string): ApiResponse<null> => ({
  code: NOT_FOUND_CODE,
  message,
  data: null,
})

/** 包裹异步处理器，将 rejection 转交 Express 错误中间件。 */
const asyncHandler =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next)
  }

/**
 * 从请求体构造创建入参。透传原始值（含 undefined），由 `AdminProductService`
 * 做权威类型/非负校验，避免在传输层重复业务规则。
 */
function toCreateInput(body: unknown): CreateProductInput {
  const b = (body ?? {}) as Record<string, unknown>
  return {
    name: b.name as string,
    pointsCost: b.pointsCost as number,
    type: b.type as ProductType,
    description: b.description as string | undefined,
    imageUrl: b.imageUrl as string | null | undefined,
    stock: b.stock as number | undefined,
    status: b.status as ProductStatus | undefined,
  }
}

/** 从请求体构造编辑补丁（仅拾取存在的字段）。 */
function toUpdatePatch(body: unknown): UpdateProductPatch {
  const b = (body ?? {}) as Record<string, unknown>
  const patch: UpdateProductPatch = {}
  if ('name' in b) patch.name = b.name as string
  if ('pointsCost' in b) patch.pointsCost = b.pointsCost as number
  if ('type' in b) patch.type = b.type as ProductType
  if ('description' in b) patch.description = b.description as string
  if ('imageUrl' in b) patch.imageUrl = b.imageUrl as string | null
  if ('stock' in b) patch.stock = b.stock as number
  if ('status' in b) patch.status = b.status as ProductStatus
  return patch
}

/**
 * 创建 `/admin/products` 路由。全部端点先经 `deps.authMiddleware` 认证，再经
 * `adminGuard` 校验管理员权限（需求 3.4, 20.4）。
 */
export function createAdminProductsRouter(deps: AdminProductsRouterDependencies): Router {
  const router = Router()

  // 认证 + 管理员 Guard 作用于本 Router 全部端点。
  router.use(deps.authMiddleware, adminGuard)

  // 创建商品（需求 12.1, 12.5）。
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const product = await deps.service.create(toCreateInput(req.body))
      res.status(201).json(success(product, PRODUCT_CREATED_MESSAGE))
    }),
  )

  // 编辑商品（需求 12.3）；不存在返回 404。
  router.put(
    '/:id',
    asyncHandler(async (req, res) => {
      const product = await deps.service.update(req.params.id, toUpdatePatch(req.body))
      if (!product) {
        res.status(404).json(notFoundEnvelope(PRODUCT_NOT_FOUND_MESSAGE))
        return
      }
      res.json(success(product, PRODUCT_UPDATED_MESSAGE))
    }),
  )

  // 上/下架状态切换（需求 12.4）；不存在返回 404。
  router.patch(
    '/:id/status',
    asyncHandler(async (req, res) => {
      const status = (req.body ?? {})?.status as ProductStatus
      const product = await deps.service.setStatus(req.params.id, status)
      if (!product) {
        res.status(404).json(notFoundEnvelope(PRODUCT_NOT_FOUND_MESSAGE))
        return
      }
      res.json(success(product, PRODUCT_STATUS_UPDATED_MESSAGE))
    }),
  )

  return router
}

/**
 * 构造生产默认 `/admin/products` 路由：Drizzle 持久化 + 基于 `JWT_SECRET` 的认证中间件。
 * 所有默认实现构造均无副作用（数据库连接惰性建立）。
 */
export function buildDefaultAdminProductsRouter(): Router {
  const service = new AdminProductService()
  const authMiddleware = createAuthMiddleware()
  return createAdminProductsRouter({ service, authMiddleware })
}
