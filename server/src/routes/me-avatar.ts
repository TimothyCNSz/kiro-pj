// /me 路由 —— 当前登录员工的个人资料头像关联（需求 22.9, 23.1, 23.3, 23.4）。
//
// 挂载端点（相对本 Router，最终位于全局前缀 + `/me` 之下）：
//   - POST /me/avatar   将一个已直传到 S3 的对象关联为**当前登录员工**的头像，
//                       返回新的 `avatarUrl`。入参 `{ objectKey }`。
//
// 「限本人」（需求 23.3）：整个路由挂在认证中间件之后，始终以 `req.user.userId`
// 作为关联目标——员工只能更换自己的头像，无法为他人设置。端点仅负责传输编解码与
// 统一响应信封，业务逻辑委托给可注入的 {@link AvatarService}；服务层以携带
// `ErrorCode` 的 `HttpError` 上抛，交由统一错误中间件序列化。
//
// 说明（任务边界）：预签名签发与格式/大小校验属于任务 6.2（UploadService），
// 商品图集关联属于任务 6.4；本路由只做「已上传对象 → 当前员工头像」的关联。
//
// Requirements: 1.15, 22.9, 23.1, 23.3, 23.4.

import { Router, type Request, type RequestHandler, type Response } from 'express'

import { success } from '../lib/api'
import { ErrorCode } from '../lib/errors'
import { createAuthMiddleware } from '../middleware/auth'
import { HttpError } from '../middleware/http-error'
import {
  AvatarService,
  DrizzleAvatarRepository,
  type AvatarServiceDependencies,
} from '../services/avatar-service'

/** 头像命令服务接口（以结构化接口耦合，便于注入替身）。 */
export interface AvatarCommandService {
  setAvatar(userId: string, objectKey: string): Promise<{ avatarUrl: string }>
}

/** `createMeAvatarRouter` 依赖（全部可注入以支持无副作用测试）。 */
export interface MeAvatarRouterDependencies {
  avatarService: AvatarCommandService
  /** 保护全部端点的认证中间件（需登录且限本人，需求 1.15、23.3）。 */
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

/** 从请求体安全取 objectKey（非空字符串），否则 422。 */
function requireObjectKey(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(ErrorCode.Validation, '缺少已上传对象的 objectKey')
  }
  return value
}

/**
 * 创建 `/me` 路由。全部端点经 `deps.authMiddleware` 保护（需求 1.15、23.3）。
 * 头像始终关联到当前登录员工（`req.user.userId`），确保「限本人」。
 */
export function createMeAvatarRouter(deps: MeAvatarRouterDependencies): Router {
  const router = Router()

  router.use(deps.authMiddleware)

  // 关联当前员工头像（需求 22.9, 23.3, 23.4）。
  router.post(
    '/avatar',
    asyncHandler(async (req, res) => {
      const userId = requireUserId(req)
      const body = (req.body ?? {}) as { objectKey?: unknown }
      const objectKey = requireObjectKey(body.objectKey)
      const result = await deps.avatarService.setAvatar(userId, objectKey)
      res.json(success(result))
    }),
  )

  return router
}

/**
 * 构造生产默认 `/me` 路由：Drizzle 头像仓储 + 基于 `JWT_SECRET` 的认证中间件。
 * 构造无副作用（数据库连接惰性建立）。
 */
export function buildDefaultMeAvatarRouter(
  overrides: Partial<AvatarServiceDependencies> = {},
): Router {
  const avatarService = new AvatarService({
    repository: overrides.repository ?? new DrizzleAvatarRepository(),
    buildUrl: overrides.buildUrl,
  })
  const authMiddleware = createAuthMiddleware()
  return createMeAvatarRouter({ avatarService, authMiddleware })
}
