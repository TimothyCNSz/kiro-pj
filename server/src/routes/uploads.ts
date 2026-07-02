// /uploads 路由（需求 22.1–22.8；见设计「后端 API 契约 · 上传」「上传相关接口鉴权」）。
//
// 挂载端点（相对本 Router，最终位于全局前缀 + `/uploads` 之下）：
//   - POST /uploads/presign   签发预签名 PUT URL（需登录）。入参
//     `{ purpose('avatar'|'product'), targetId, contentType, size }`；返回
//     `{ uploadUrl, objectKey, publicUrl }`（统一响应信封）。
//
// 上传预签名需登录（需求 1.15）：整个路由挂在认证中间件之后，`req.user`
// 作为鉴权主体。端点仅负责传输编解码与统一响应信封，鉴权与格式/大小校验委托
// 给可注入的 {@link UploadService}；服务层以携带 `ErrorCode` 的 `HttpError`
// 上抛（UNSUPPORTED_IMAGE_TYPE / IMAGE_TOO_LARGE / FORBIDDEN），交由统一错误
// 中间件序列化（商品图需管理员、头像限本人，设计「上传相关接口鉴权」）。
//
// Requirements: 1.15, 22.1, 22.2, 22.3, 22.4, 22.5, 22.6, 22.7, 22.8.

import { Router, type Request, type RequestHandler, type Response } from 'express'

import { success } from '../lib/api'
import { ErrorCode } from '../lib/errors'
import { createAuthMiddleware } from '../middleware/auth'
import { HttpError } from '../middleware/http-error'
import {
  UploadService,
  type AuthContext,
  type PresignRequest,
  type PresignResult,
} from '../services/upload-service'

/** 上传预签名服务接口（以结构化接口耦合，便于注入替身）。 */
export interface UploadCommandService {
  presign(actor: AuthContext, req: PresignRequest): Promise<PresignResult>
}

/** `createUploadsRouter` 依赖（全部可注入以支持无副作用测试）。 */
export interface UploadsRouterDependencies {
  uploadService: UploadCommandService
  /** 保护全部端点的认证中间件（预签名需登录，需求 1.15）。 */
  authMiddleware: RequestHandler
}

/** 包裹异步处理器，将 rejection 转交 Express 错误中间件。 */
const asyncHandler =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next)
  }

/** 取当前登录主体；缺失（未认证）以 401 拒绝——一般不会发生（已挂认证中间件）。 */
function requireActor(req: Request): AuthContext {
  const user = req.user
  if (!user) {
    throw new HttpError(ErrorCode.Unauthenticated, '未登录或会话已过期，请重新登录')
  }
  return { userId: user.userId, role: user.role }
}

const VALID_PURPOSES = new Set<PresignRequest['purpose']>(['avatar', 'product'])

/** 从请求体解析并校验 presign 入参；结构非法以 VALIDATION(422) 拒绝。 */
function parsePresignRequest(body: unknown): PresignRequest {
  const b = (body ?? {}) as Record<string, unknown>
  const { purpose, targetId, contentType, size } = b

  if (typeof purpose !== 'string' || !VALID_PURPOSES.has(purpose as PresignRequest['purpose'])) {
    throw new HttpError(ErrorCode.Validation, '缺少或非法的上传用途 purpose')
  }
  if (typeof targetId !== 'string' || targetId.trim().length === 0) {
    throw new HttpError(ErrorCode.Validation, '缺少目标 id targetId')
  }
  if (typeof contentType !== 'string' || contentType.trim().length === 0) {
    throw new HttpError(ErrorCode.Validation, '缺少图片类型 contentType')
  }
  if (typeof size !== 'number' || !Number.isFinite(size)) {
    throw new HttpError(ErrorCode.Validation, '缺少或非法的图片大小 size')
  }

  return { purpose: purpose as PresignRequest['purpose'], targetId, contentType, size }
}

/**
 * 创建 `/uploads` 路由。全部端点经 `deps.authMiddleware` 保护（需登录，需求 1.15）。
 * 鉴权（商品图需管理员、头像限本人）与格式/大小校验由 {@link UploadService} 负责。
 */
export function createUploadsRouter(deps: UploadsRouterDependencies): Router {
  const router = Router()

  router.use(deps.authMiddleware)

  // 签发预签名 PUT URL（需求 22.1–22.8）。
  router.post(
    '/presign',
    asyncHandler(async (req, res) => {
      const actor = requireActor(req)
      const presignReq = parsePresignRequest(req.body)
      const result = await deps.uploadService.presign(actor, presignReq)
      res.json(success(result))
    }),
  )

  return router
}

/**
 * 构造生产默认 `/uploads` 路由：默认 S3 预签名原语 + 基于 `JWT_SECRET` 的认证中间件。
 * 构造无副作用（AWS 客户端惰性建立）。
 */
export function buildDefaultUploadsRouter(
  overrides: Partial<UploadsRouterDependencies> = {},
): Router {
  const uploadService = overrides.uploadService ?? new UploadService()
  const authMiddleware = overrides.authMiddleware ?? createAuthMiddleware()
  return createUploadsRouter({ uploadService, authMiddleware })
}
