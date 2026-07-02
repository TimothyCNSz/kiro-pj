// /cart 路由（需求 6.1, 6.2, 6.4, 6.5, 6.6；见设计「后端 API 契约」购物车分组）。
//
// 挂载以下端点（相对本 Router，最终位于全局前缀 + `/cart` 之下）：
//   - GET    /cart                     读取服务端购物车（明细 + 小计 + 应付总额，6.5, 6.6）。
//   - POST   /cart/items               加入商品并更新数量（6.1）。入参 `{ productId, quantity }`。
//   - PATCH  /cart/items/:productId    调整某商品数量，实时重算总额（6.2）。入参 `{ quantity }`。
//   - DELETE /cart/items/:productId    移除某条目，实时重算总额（6.4）。
//
// 购物车需登录（需求 1.15、6.6）：整个路由挂在认证中间件之后，`req.user.userId`
// 作为购物车归属。端点仅负责传输编解码与统一响应信封，业务逻辑委托给可注入的
// {@link CartService}；服务层以携带 `ErrorCode` 的 `HttpError` 上抛，交由统一错误
// 中间件序列化。
//
// 说明：零库存禁止加购、超库存阻止结算属于任务 7.3，本路由不实现库存强约束。
//
// Requirements: 1.15, 6.1, 6.2, 6.4, 6.5, 6.6.

import { Router, type Request, type RequestHandler, type Response } from 'express'

import { success } from '../lib/api'
import { ErrorCode } from '../lib/errors'
import { createAuthMiddleware } from '../middleware/auth'
import { HttpError } from '../middleware/http-error'
import {
  CartService,
  DrizzleCartRepository,
  type CartServiceDependencies,
  type CartView,
} from '../services/cart-service'

/** 购物车命令服务接口（以结构化接口耦合，便于注入替身）。 */
export interface CartCommandService {
  getCart(userId: string): Promise<CartView>
  addItem(userId: string, productId: string, quantity: number): Promise<CartView>
  updateItem(userId: string, productId: string, quantity: number): Promise<CartView>
  removeItem(userId: string, productId: string): Promise<CartView>
}

/** `createCartRouter` 依赖（全部可注入以支持无副作用测试）。 */
export interface CartRouterDependencies {
  cartService: CartCommandService
  /** 保护全部端点的认证中间件（购物车需登录，需求 1.15、6.6）。 */
  authMiddleware: RequestHandler
}

/** 包裹异步处理器，将 rejection 转交 Express 错误中间件。 */
const asyncHandler =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next)
  }

/** 取当前登录用户 id；缺失（未认证）以 401 拒绝——一般不会发生（已挂认证中间件）。 */
function requireUserId(req: Request): string {
  const userId = req.user?.userId
  if (!userId) {
    throw new HttpError(ErrorCode.Unauthenticated, '未登录或会话已过期，请重新登录')
  }
  return userId
}

/** 从请求体安全取 productId（非空字符串），否则 422。 */
function requireProductId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(ErrorCode.Validation, '缺少商品 id')
  }
  return value
}

/**
 * 创建 `/cart` 路由。全部端点经 `deps.authMiddleware` 保护（需求 1.15、6.6）。
 * 数量的合法性校验（>= 1 整数）由 {@link CartService} 负责。
 */
export function createCartRouter(deps: CartRouterDependencies): Router {
  const router = Router()

  router.use(deps.authMiddleware)

  // 读取购物车（需求 6.5, 6.6）。
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const cart = await deps.cartService.getCart(requireUserId(req))
      res.json(success(cart))
    }),
  )

  // 加入商品并更新数量（需求 6.1）。
  router.post(
    '/items',
    asyncHandler(async (req, res) => {
      const userId = requireUserId(req)
      const body = (req.body ?? {}) as { productId?: unknown; quantity?: unknown }
      const productId = requireProductId(body.productId)
      const cart = await deps.cartService.addItem(userId, productId, body.quantity as number)
      res.status(201).json(success(cart))
    }),
  )

  // 调整某商品数量（需求 6.2）。
  router.patch(
    '/items/:productId',
    asyncHandler(async (req, res) => {
      const userId = requireUserId(req)
      const body = (req.body ?? {}) as { quantity?: unknown }
      const cart = await deps.cartService.updateItem(
        userId,
        req.params.productId,
        body.quantity as number,
      )
      res.json(success(cart))
    }),
  )

  // 移除某条目（需求 6.4）。
  router.delete(
    '/items/:productId',
    asyncHandler(async (req, res) => {
      const userId = requireUserId(req)
      const cart = await deps.cartService.removeItem(userId, req.params.productId)
      res.json(success(cart))
    }),
  )

  return router
}

/**
 * 构造生产默认 `/cart` 路由：Drizzle 购物车仓储 + 基于 `JWT_SECRET` 的认证中间件。
 * 构造无副作用（数据库连接惰性建立）。
 */
export function buildDefaultCartRouter(overrides: Partial<CartServiceDependencies> = {}): Router {
  const cartService = new CartService({
    repository: overrides.repository ?? new DrizzleCartRepository(),
  })
  const authMiddleware = createAuthMiddleware()
  return createCartRouter({ cartService, authMiddleware })
}
