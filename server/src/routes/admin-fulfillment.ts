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

import { Router, type Request, type RequestHandler, type Response } from 'express'

import { paginated, success, type ApiResponse } from '../lib/api'
import { adminGuard, createAuthMiddleware } from '../middleware/auth'
import { NOT_FOUND_CODE } from '../middleware/error-handler'
import { OrderStatus, OrderType } from '../lib/domain'
import {
  FulfillmentService,
  type ShipPhysicalResult,
  type ShipVirtualResult,
} from '../services/fulfillment-service'
import { AdminOrderService, type AdminOrderRow } from '../services/admin-order-service'

/** 实物发货成功提示。 */
export const SHIP_PHYSICAL_OK_MESSAGE = '实物订单已发货'
/** 虚拟发货成功提示。 */
export const SHIP_VIRTUAL_OK_MESSAGE = '虚拟订单已发货'
/** 订单不存在提示（无对应领域错误码，用通用 404 信封）。 */
export const ORDER_NOT_FOUND_MESSAGE = '订单不存在'

/** 发货命令服务接口（以结构化接口耦合，便于注入替身）。 */
export interface FulfillmentCommandService {
  shipPhysical(
    adminId: string,
    orderId: string,
    trackingNo: unknown,
  ): Promise<ShipPhysicalResult | null>
  shipVirtual(adminId: string, orderId: string): Promise<ShipVirtualResult | null>
}

/** 管理端订单列表查询服务接口（供发货页展示与选择）。 */
export interface AdminOrderQueryService {
  listOrders(params: {
    status?: OrderStatus
    type?: OrderType
    page: number
    pageSize: number
  }): Promise<{ list: AdminOrderRow[]; total: number; page: number; pageSize: number }>
}

/** `createAdminFulfillmentRouter` 依赖（全部可注入以支持无副作用测试）。 */
export interface AdminFulfillmentRouterDependencies {
  fulfillmentService: FulfillmentCommandService
  /** 订单列表查询服务（GET /admin/orders）。 */
  orderQueryService: AdminOrderQueryService
  /** 认证中间件（挂在 adminGuard 之前）。 */
  authMiddleware: RequestHandler
}

/** 从查询串解析订单状态筛选（非法值忽略）。 */
function parseStatus(v: unknown): OrderStatus | undefined {
  return v === OrderStatus.PendingShipment || v === OrderStatus.Shipped
    ? (v as OrderStatus)
    : undefined
}

/** 从查询串解析订单类型筛选（非法值忽略）。 */
function parseType(v: unknown): OrderType | undefined {
  return v === OrderType.Physical || v === OrderType.Virtual ? (v as OrderType) : undefined
}

/** 从查询串解析分页（缺省 page=1、pageSize=20）。 */
function parsePage(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback
}

/** 通用 404 信封（订单不存在，无对应领域错误码）。 */
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
 * 创建 `/admin/orders` 发货子路由（`POST /:id/ship-physical`、`POST /:id/ship-virtual`）。
 * 每个端点先经认证中间件再经 `adminGuard`（需求 3.3, 3.4, 20.4）。
 */
export function createAdminFulfillmentRouter(deps: AdminFulfillmentRouterDependencies): Router {
  const router = Router()

  // 订单列表（需管理员）：支持按 status / type 筛选与分页，供发货页展示与选择。
  router.get(
    '/',
    deps.authMiddleware,
    adminGuard,
    asyncHandler(async (req, res) => {
      const result = await deps.orderQueryService.listOrders({
        status: parseStatus(req.query.status),
        type: parseType(req.query.type),
        page: parsePage(req.query.page, 1),
        pageSize: parsePage(req.query.pageSize, 20),
      })
      res.json(
        paginated(result.list, {
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
        }),
      )
    }),
  )

  // 实物发货（需求 8.2, 8.3, 14.1, 14.3）。
  router.post(
    '/:id/ship-physical',
    deps.authMiddleware,
    adminGuard,
    asyncHandler(async (req, res) => {
      const adminId = req.user!.userId
      const trackingNo = (req.body as { trackingNo?: unknown } | undefined)?.trackingNo
      const result = await deps.fulfillmentService.shipPhysical(adminId, req.params.id, trackingNo)
      if (!result) {
        res.status(404).json(notFoundEnvelope(ORDER_NOT_FOUND_MESSAGE))
        return
      }
      res.json(success(result, SHIP_PHYSICAL_OK_MESSAGE))
    }),
  )

  // 虚拟发货（需求 9.3, 9.4, 14.2）。
  router.post(
    '/:id/ship-virtual',
    deps.authMiddleware,
    adminGuard,
    asyncHandler(async (req, res) => {
      const adminId = req.user!.userId
      const result = await deps.fulfillmentService.shipVirtual(adminId, req.params.id)
      if (!result) {
        res.status(404).json(notFoundEnvelope(ORDER_NOT_FOUND_MESSAGE))
        return
      }
      res.json(success(result, SHIP_VIRTUAL_OK_MESSAGE))
    }),
  )

  return router
}

/**
 * 构造生产默认发货路由：Drizzle 持久化 + 基于 `JWT_SECRET` 的认证中间件。
 * 所有默认实现构造均无副作用（数据库连接惰性建立）。
 */
export function buildDefaultAdminFulfillmentRouter(): Router {
  return createAdminFulfillmentRouter({
    fulfillmentService: new FulfillmentService(),
    orderQueryService: new AdminOrderService(),
    authMiddleware: createAuthMiddleware(),
  })
}
