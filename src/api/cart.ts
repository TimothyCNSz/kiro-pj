import http from '@/api/http'
import type { ApiResponse } from '@/types'

/** 购物车条目（服务端权威计算 subtotal/totalPoints） */
export interface CartItem {
  productId: string
  name: string
  /** 单价（所需积分） */
  unitPoints: number
  quantity: number
  /** 小计 = unitPoints * quantity（以服务端返回为准） */
  subtotal: number
}

/** 购物车视图数据 */
export interface Cart {
  items: CartItem[]
  /** 应付积分总额（以服务端返回为准） */
  totalPoints: number
}

/**
 * 规范化的 API 错误，便于视图/Store 依据 HTTP 状态码或错误分类码映射提示文案。
 * - `code`：后端返回的分类码，如 `INSUFFICIENT_STOCK`（超库存/零库存）。
 */
export interface ApiError {
  status?: number
  code?: string | number
  message?: string
  raw?: unknown
}

// `http.ts` 的响应拦截器返回 ApiResponse 信封（`response.data`），
// 因此运行时拿到的是 `{ code, message, data }`，需做类型断言。
async function get<T>(url: string, params?: Record<string, unknown>): Promise<ApiResponse<T>> {
  return (await http.get(url, { params })) as unknown as ApiResponse<T>
}

async function post<T>(url: string, body?: unknown): Promise<ApiResponse<T>> {
  return (await http.post(url, body)) as unknown as ApiResponse<T>
}

async function patch<T>(url: string, body?: unknown): Promise<ApiResponse<T>> {
  return (await http.patch(url, body)) as unknown as ApiResponse<T>
}

async function del<T>(url: string): Promise<ApiResponse<T>> {
  return (await http.delete(url)) as unknown as ApiResponse<T>
}

/** 读取服务端购物车（跨会话/跨设备持久化，需求 6.5、6.6） */
export async function getCart(): Promise<Cart> {
  const res = await get<Cart>('/cart')
  return res.data
}

/** 加入商品（校验上架 + 有库存，需求 6.1、5.2） */
export async function addItem(productId: string, quantity: number): Promise<Cart> {
  const res = await post<Cart>('/cart/items', { productId, quantity })
  return res.data
}

/** 调整某商品数量（校验不超库存，需求 6.2、6.3） */
export async function updateItem(productId: string, quantity: number): Promise<Cart> {
  const res = await patch<Cart>(`/cart/items/${encodeURIComponent(productId)}`, { quantity })
  return res.data
}

/** 移除某条目（需求 6.4） */
export async function removeItem(productId: string): Promise<Cart> {
  const res = await del<Cart>(`/cart/items/${encodeURIComponent(productId)}`)
  return res.data
}

/**
 * 将 axios 抛出的错误规范化为 {@link ApiError}，
 * 便于依据 HTTP 状态码 / 分类码（如 INSUFFICIENT_STOCK）映射提示文案。
 */
export function toApiError(err: unknown): ApiError {
  const anyErr = err as {
    response?: { status?: number; data?: unknown }
    message?: string
  }
  const response = anyErr?.response
  const envelope = response?.data as { code?: string | number; message?: string } | undefined

  return {
    status: response?.status,
    code: envelope?.code,
    message: envelope?.message ?? anyErr?.message,
    raw: err,
  }
}

/** 判断错误是否为库存不足（超库存 / 零库存，需求 6.3、5.2） */
export function isInsufficientStock(err: ApiError): boolean {
  return err.code === 'INSUFFICIENT_STOCK'
}
