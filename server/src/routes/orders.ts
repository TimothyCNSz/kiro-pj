// /orders 与 /points 路由（需求 10.1–10.3, 11.1–11.4；见设计「后端 API 契约」
// 订单/积分分组）。
//
// 挂载以下端点（相对各自 Router，最终位于全局前缀之下）：
//   - GET /orders?page=   分页返回当前员工兑换历史（时间倒序、字段完整，需求 11.1–11.4）。
//   - GET /orders/:id     单个订单详情（实物物流 / 虚拟 CDK 视状态展示，需求 8.3, 9.3, 9.4）；
//                         非本人订单或不存在则交由 notFoundHandler 返回 404。
//   - GET /points/balance 当前员工可用积分余额（需求 10.1–10.3）。
//
// 全部端点均需登录（需求 1.15）：整个路由挂在认证中间件之后，`req.user.userId` 作为
// 查询主体——员工只能查看属于自己的历史、订单与余额。端点仅负责传输编解码与统一响应
// 信封，业务逻辑委托给可注入的 {@link OrderHistoryQueryService}。
//
// Requirements: 1.15, 8.3, 9.3, 9.4, 10.1, 10.2, 10.3, 11.1, 11.2, 11.3, 11.4.

import { Router, type Request, type RequestHandler, type Response } from 'express'

import { paginated, success, type PaginatedData } from '../lib/api'
import { ErrorCode } from '../lib/errors'
import { createAuthMiddleware } from '../middleware/auth'
import { HttpError } from '../middleware/http-error'
import {
  DrizzleOrderHistoryRepository,
  OrderHistoryService,
  type OrderDetailView,
  type OrderHistoryItem,
} from '../services/order-history-service'
import { parsePagination } from './products'

/** 订单历史/详情/余额查询服务接口（结构化耦合，便于注入替身）。 */
export interface OrderHistoryQueryService {
  listOrders(
    userId: string,
    pagination: { page: number; pageSize: number },
  ): Promise<PaginatedData<OrderHistoryItem>>
  getOrder(userId: string, orderId: string): Promise<OrderDetailView | null>
  getBalance(userId: string): Promise<number>
}

/** `createOrdersRouter` / `createPointsRouter` 依赖（可注入以支持无副作用测试）。 */
export interface OrdersRouterDependencies {
  orderHistoryService: OrderHistoryQueryService
  /** 保护全部端点的认证中间件（查询需登录，需求 1.15）。 */
  authMiddleware: RequestHandler
}

/** 余额响应信封的数据部分。 */
export interface BalanceResponse {
  /** 当前可用积分余额（恒非负，需求 10.3）。 */
  balance: number
}

/** 包裹异步处理器，将 rejection 转交 Express 错误中间件。 */
const asyncHandler =
  (fn: (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next)
  }

/** 取当前登录用户 id；缺失（未认证）以 401 拒绝——一般不会发生（已挂认证中间件）。 */
function requireUserId(req: Request): string {
  const userId = req.user?.userId
  if (!userId) {
    throw new HttpError(ErrorCode.Unauthenticated, '未登录或会话已过期，请重新登录')
  }
  return userId
}

/**
 * 创建 `/orders` 路由。全部端点经 `deps.authMiddleware` 保护（需求 1.15），
 * 并以 `req.user.userId` 限定为当前员工自身的订单。
 */
export function createOrdersRouter(deps: OrdersRouterDependencies): Router {
  const router = Router()

  router.use(deps.authMiddleware)

  // 兑换历史（需登录）：分页、时间倒序、字段完整（需求 11.1–11.4）。
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const userId = requireUserId(req)
      const pagination = parsePagination(req.query)
      const result = await deps.orderHistoryService.listOrders(userId, pagination)
      res.json(
        paginated(result.list, {
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
        }),
      )
    }),
  )

  // 订单详情（需登录）：限本人；不存在/越权交由 notFoundHandler 返回 404（需求 8.3, 9.3, 9.4）。
  router.get(
    '/:id',
    asyncHandler(async (req, res, next) => {
      const userId = requireUserId(req)
      const detail = await deps.orderHistoryService.getOrder(userId, req.params.id)
      if (!detail) {
        next()
        return
      }
      res.json(success(detail))
    }),
  )

  return router
}

/**
 * 创建 `/points` 路由（当前仅 `GET /balance`）。经认证中间件保护，限当前员工（需求 1.15）。
 */
export function createPointsRouter(deps: OrdersRouterDependencies): Router {
  const router = Router()

  router.use(deps.authMiddleware)

  // 积分余额（需登录）：当前员工可用余额，恒非负（需求 10.1–10.3）。
  router.get(
    '/balance',
    asyncHandler(async (req, res) => {
      const userId = requireUserId(req)
      const balance = await deps.orderHistoryService.getBalance(userId)
      res.json(success<BalanceResponse>({ balance }))
    }),
  )

  return router
}

/**
 * 构造生产默认 `/orders` 路由：Drizzle 历史仓储 + 基于 `JWT_SECRET` 的认证中间件。
 * 构造无副作用（数据库连接惰性建立）。
 */
export function buildDefaultOrdersRouter(): Router {
  const orderHistoryService = new OrderHistoryService({
    repository: new DrizzleOrderHistoryRepository(),
  })
  return createOrdersRouter({ orderHistoryService, authMiddleware: createAuthMiddleware() })
}

/**
 * 构造生产默认 `/points` 路由：Drizzle 历史仓储 + 基于 `JWT_SECRET` 的认证中间件。
 * 构造无副作用（数据库连接惰性建立）。
 */
export function buildDefaultPointsRouter(): Router {
  const orderHistoryService = new OrderHistoryService({
    repository: new DrizzleOrderHistoryRepository(),
  })
  return createPointsRouter({ orderHistoryService, authMiddleware: createAuthMiddleware() })
}
