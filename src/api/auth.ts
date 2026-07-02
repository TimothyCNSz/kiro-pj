import http from '@/api/http'
import type { ApiResponse } from '@/types'

/** 用户角色 */
export type Role = 'employee' | 'admin'

/** 注册结果：账号被创建为「待验证」；emailSendFailed 表示验证邮件是否发送失败 */
export interface RegisterResult {
  status: 'pending_verification'
  emailSendFailed?: boolean
}

/** 邮箱验证结果：账号被置为「已激活」 */
export interface VerifyEmailResult {
  status: 'active'
}

/** 登录结果 */
export interface LoginResult {
  token: string
  role: Role
}

/** 当前用户信息 */
export interface MeResult {
  userId: string
  role: Role
}

/**
 * 规范化的 API 错误。
 * - `status`：HTTP 状态码（如 401/403/409/410/422/202）
 * - `code`：后端返回的分类码（数字信封 code，或错误分类字符串，如 EMAIL_TAKEN）
 * - `fieldErrors`：注册校验时的逐项错误（字段 -> 错误信息）
 */
export interface ApiError {
  status?: number
  code?: string | number
  message?: string
  fieldErrors?: Record<string, string>
  raw?: unknown
}

// `http.ts` 的响应拦截器会返回 ApiResponse 信封（`response.data`），
// 因此运行时拿到的是 `{ code, message, data }`，需要做类型断言。
async function post<T>(url: string, body?: unknown): Promise<ApiResponse<T>> {
  return (await http.post(url, body)) as unknown as ApiResponse<T>
}

async function get<T>(url: string, params?: Record<string, unknown>): Promise<ApiResponse<T>> {
  return (await http.get(url, { params })) as unknown as ApiResponse<T>
}

/** 注册：公司邮箱 + 密码，创建「待验证」员工账号并触发验证邮件 */
export async function register(email: string, password: string): Promise<RegisterResult> {
  const res = await post<RegisterResult>('/auth/register', { email, password })
  return res.data
}

/** 通过验证链接/验证码完成邮箱验证 */
export async function verifyEmail(token: string): Promise<VerifyEmailResult> {
  const res = await get<VerifyEmailResult>('/auth/verify-email', { token })
  return res.data
}

/** 对「待验证」账号重发验证邮件（旧令牌失效） */
export async function resendVerification(email: string): Promise<void> {
  await post<null>('/auth/resend-verification', { email })
}

/** 登录：仅「已激活」账号可登录，返回 token + role */
export async function login(email: string, password: string): Promise<LoginResult> {
  const res = await post<LoginResult>('/auth/login', { email, password })
  return res.data
}

/** 登出：立即终止会话 */
export async function logout(): Promise<void> {
  await post<null>('/auth/logout')
}

/** 获取当前用户信息（同时刷新会话活跃时间） */
export async function fetchMe(): Promise<MeResult> {
  const res = await get<MeResult>('/auth/me')
  return res.data
}

/**
 * 将 axios 抛出的错误规范化为 {@link ApiError}，
 * 便于视图层依据 HTTP 状态码 / 分类码映射提示文案。
 */
export function toApiError(err: unknown): ApiError {
  const anyErr = err as {
    response?: { status?: number; data?: unknown }
    message?: string
  }
  const response = anyErr?.response
  const envelope = response?.data as
    | { code?: string | number; message?: string; data?: unknown }
    | undefined

  const result: ApiError = {
    status: response?.status,
    code: envelope?.code,
    message: envelope?.message ?? anyErr?.message,
    raw: err,
  }

  // 尝试从信封中提取逐项字段错误（注册校验失败场景）
  const payload = envelope?.data as
    | { fieldErrors?: Record<string, string>; errors?: Record<string, string> }
    | undefined
  const fieldErrors = payload?.fieldErrors ?? payload?.errors
  if (fieldErrors && typeof fieldErrors === 'object') {
    result.fieldErrors = fieldErrors
  }

  return result
}
