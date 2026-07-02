// /products 路由（需求 4.1–4.6；见设计「后端 API 契约」商品分组）。
//
// 挂载以下端点（相对本 Router，最终位于全局前缀 + `/products` 之下）：
//   - GET /products              分页返回上架商品列表（名称/主图/所需积分/库存状态，4.1, 4.2）。
//   - GET /products/search?q=    名称匹配的上架商品；无匹配返回空列表（4.3, 4.4）。
//   - GET /products/:id          商品详情（含类型与图集）；不存在则 404（4.5, 4.6）。
//
// 商品浏览需登录（需求 1.15）：整个路由挂在认证中间件之后。端点仅负责传输编解码与
// 统一响应信封，业务逻辑委托给可注入的 `CatalogService`。
//
// Requirements: 1.15, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6.

import { Router, type Request, type RequestHandler, type Response } from 'express'

import { paginated, success } from '../lib/api'
import { createAuthMiddleware } from '../middleware/auth'
import {
  CatalogService,
  DrizzleCatalogProductRepository,
  type CatalogServiceDependencies,
} from '../services/catalog-service'

/** 分页默认与上限（演示级）。 */
export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 100

/** 从查询参数安全解析分页（非法/缺省回退默认，pageSize 限幅）。 */
export function parsePagination(query: Request['query']): { page: number; pageSize: number } {
  const rawPage = Number(query.page)
  const rawSize = Number(query.pageSize)
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1
  const pageSize =
    Number.isFinite(rawSize) && rawSize >= 1
      ? Math.min(Math.floor(rawSize), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE
  return { page, pageSize }
}

/** 安全地将未知输入取为字符串（非字符串回退空串）。 */
const asString = (v: unknown): string => (typeof v === 'string' ? v : '')

/** 包裹异步处理器，将 rejection 转交 Express 错误中间件。 */
const asyncHandler =
  (fn: (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next)
  }

/** `createProductsRouter` 依赖（可注入以支持无副作用测试）。 */
export interface ProductsRouterDependencies {
  catalogService: Pick<CatalogService, 'listProducts' | 'searchProducts' | 'getProduct'>
  /** 保护全部端点的认证中间件（商品浏览需登录，需求 1.15）。 */
  authMiddleware: RequestHandler
}

/**
 * 创建 `/products` 路由。全部端点经 `deps.authMiddleware` 保护（需求 1.15）。
 * 注意 `/search` 须先于 `/:id` 注册，避免被参数路由捕获。
 */
export function createProductsRouter(deps: ProductsRouterDependencies): Router {
  const router = Router()

  router.use(deps.authMiddleware)

  // 列表（需登录）：分页返回上架商品（需求 4.1, 4.2）。
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const pagination = parsePagination(req.query)
      const result = await deps.catalogService.listProducts(pagination)
      res.json(paginated(result.list, { total: result.total, page: result.page, pageSize: result.pageSize }))
    }),
  )

  // 搜索（需登录）：名称匹配的上架商品；无匹配返回空列表（需求 4.3, 4.4）。
  router.get(
    '/search',
    asyncHandler(async (req, res) => {
      const keyword = asString(req.query.q)
      const pagination = parsePagination(req.query)
      const result = await deps.catalogService.searchProducts(keyword, pagination)
      res.json(paginated(result.list, { total: result.total, page: result.page, pageSize: result.pageSize }))
    }),
  )

  // 详情（需登录）：含类型与图集；不存在则交由 notFoundHandler 返回 404（需求 4.5, 4.6）。
  router.get(
    '/:id',
    asyncHandler(async (req, res, next) => {
      const detail = await deps.catalogService.getProduct(req.params.id)
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
 * 构造生产默认 `/products` 路由：Drizzle 商品仓储 + 基于 `JWT_SECRET` 的认证中间件。
 * 默认库存解析采用 `Product.stock`；虚拟商品的可用 CDK 计数由任务 5.4 通过注入
 * `stockResolver` 接入。构造无副作用（数据库连接惰性建立）。
 */
export function buildDefaultProductsRouter(overrides: Partial<CatalogServiceDependencies> = {}): Router {
  const catalogService = new CatalogService({
    repository: overrides.repository ?? new DrizzleCatalogProductRepository(),
    stockResolver: overrides.stockResolver,
    placeholderUrl: overrides.placeholderUrl,
  })
  const authMiddleware = createAuthMiddleware()
  return createProductsRouter({ catalogService, authMiddleware })
}
