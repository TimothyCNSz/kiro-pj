// Express application factory for the single monolithic backend.
//
// The same app instance is wrapped by the serverless-express adapter in
// `handler.ts` (for API Gateway `{proxy+}` events) and can also be exercised
// directly by Supertest in tests. All feature routers hang off a global prefix
// so the backend keeps its own routing under API Gateway's catch-all proxy.
//
// Requirements: 19.3 (Lambda adapter + framework skeleton; unified responses).

import express, { type Express } from 'express'
import { registerRoutes } from './routes'
import { errorHandler, notFoundHandler } from './middleware/error-handler'

/**
 * 全局路由前缀。与前端 `src/api/http.ts` 的 `baseURL` (`/api`) 及 CloudFront
 * `/api/*` 行为对齐；可经 `API_PREFIX` 覆盖。API Gateway `{proxy+}` 会把完整
 * 路径（含 `/api`）透传给 Lambda，故这里在 Express 侧挂载同名前缀。
 */
export const GLOBAL_PREFIX = process.env.API_PREFIX ?? '/api'

/** 创建并配置 Express 应用（供 Lambda 适配器与测试共用）。 */
export function createApp(): Express {
  const app = express()
  app.disable('x-powered-by')

  // 解析 JSON 请求体（API Gateway 代理事件的 body 由适配器交给 Express）。
  app.use(express.json())

  const router = express.Router()
  registerRoutes(router)
  app.use(GLOBAL_PREFIX, router)

  // 统一响应/错误序列化：先处理未匹配路由（404），再处理抛出的错误。
  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
