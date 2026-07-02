import http from '@/api/http'
import type { ApiResponse } from '@/types'

/**
 * 兑换（结算）API 客户端（需求 7）。
 *
 * - `checkout`：以当前用户的服务端购物车整体结算（需求 7.1、7.3、7.4、7.8、7.9）。
 * - `instant`：对单件商品发起立即兑换（需求 7.2、7.4、7.8）。
 * - 二者均可携带配送地址；当兑换包含实物商品时地址为必填（需求 7.3），
 *   最终由后端权威校验并可能返回 `ADDRESS_REQUIRED`。
 */

/** 配送地址（实物商品必填，需求 7.3、8.1） */
export interface Address {
  /** 收件人姓名 */
  recipient: string
  /** 联系电话 */
  phone: string
  /** 详细配送地址 */
  detail: string
}

/** 订单类型：按商品类型拆分为实物 / 虚拟订单（需求 7.9） */
export type OrderType = 'physical' | 'virtual'

/** 订单条目摘要 */
export interface OrderItemSummary {
  productId: string
  name: string
  /** 单价（所需积分） */
  unitPoints: number
  quantity: number
  /** 小计 = unitPoints * quantity */
  subtotal: number
}

/**
 * 兑换订单摘要（一次兑换可按类型拆分为多张订单，需求 7.9）。
 * 状态、CDK、物流等明细以订单详情接口为准，这里仅承载结算返回的概要。
 */
export interface OrderSummary {
  id: string
  type: OrderType
  status: string
  items: OrderItemSummary[]
  /** 该订单消耗的积分 */
  totalPoints: number
  createdAt: string
}

/**
 * 规范化的 API 错误，便于视图/Store 依据 HTTP 状态码或错误分类码映射本地化提示。
 * - `code`：后端返回的字符串错误码，如 `INSUFFICIENT_POINTS`、`INSUFFICIENT_STOCK`、`ADDRESS_REQUIRED`。
 */
export interface ApiError {
  status?: number
  code?: string | number
  message?: string
  raw?: unknown
}

/** 兑换相关的后端错误码常量（需求 5.4、5.5、7.3） */
export const REDEMPTION_ERROR_CODES = {
  /** 可用积分小于应付积分总额（需求 5.4） */
  INSUFFICIENT_POINTS: 'INSUFFICIENT_POINTS',
  /** 任一商品请求数量超过当前库存（需求 5.5） */
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  /** 兑换包含实物商品但未提供配送地址（需求 7.3） */
  ADDRESS_REQUIRED: 'ADDRESS_REQUIRED',
} as const

// `http.ts` 的响应拦截器返回 ApiResponse 信封（`response.data`），
// 因此运行时拿到的是 `{ code, message, data }`，需做类型断言（与 cart.ts / catalog.ts 约定一致）。
async function post<T>(url: string, body?: unknown): Promise<ApiResponse<T>> {
  return (await http.post(url, body)) as unknown as ApiResponse<T>
}

/**
 * 购物车结算（需求 7.1、7.3、7.4、7.8、7.9）。
 * 兑换成功后后端会从购物车移除已兑换商品（需求 7.5），调用方应重新加载购物车。
 * @param address 配送地址；含实物商品时必填，否则后端可能返回 `ADDRESS_REQUIRED`。
 */
export async function checkout(address?: Address): Promise<OrderSummary[]> {
  const res = await post<OrderSummary[]>('/redemptions/checkout', address ? { address } : {})
  return res.data
}

/**
 * 立即兑换单件商品（需求 7.2、7.4、7.8）。
 * @param productId 目标商品 id
 * @param quantity 兑换数量，默认 1
 * @param address 配送地址；实物商品必填，否则后端可能返回 `ADDRESS_REQUIRED`。
 */
export async function instant(
  productId: string,
  quantity = 1,
  address?: Address,
): Promise<OrderSummary[]> {
  const body: Record<string, unknown> = { productId, quantity }
  if (address) body.address = address
  const res = await post<OrderSummary[]>('/redemptions/instant', body)
  return res.data
}

/**
 * 将 axios 抛出的错误规范化为 {@link ApiError}，
 * 便于依据 HTTP 状态码 / 分类码映射本地化提示文案。
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

/** 积分不足（需求 5.4） */
export function isInsufficientPoints(err: ApiError): boolean {
  return err.code === REDEMPTION_ERROR_CODES.INSUFFICIENT_POINTS
}

/** 库存不足（需求 5.5） */
export function isInsufficientStock(err: ApiError): boolean {
  return err.code === REDEMPTION_ERROR_CODES.INSUFFICIENT_STOCK
}

/** 缺少配送地址（实物商品，需求 7.3） */
export function isAddressRequired(err: ApiError): boolean {
  return err.code === REDEMPTION_ERROR_CODES.ADDRESS_REQUIRED
}

/**
 * 将规范化错误映射为 i18n `errors.*` 文案键（需求 17）。
 * 已知的字符串错误码直接透传作为键（与 `locales` 中 `errors` 命名空间一一对应），
 * 未知错误回退到 `errors.UNKNOWN`。
 */
export function errorMessageKey(err: ApiError): string {
  const known = [
    'INSUFFICIENT_POINTS',
    'INSUFFICIENT_STOCK',
    'ADDRESS_REQUIRED',
    'CONCURRENCY_CONFLICT',
    'VALIDATION',
    'FORBIDDEN',
    'UNAUTHENTICATED',
  ]
  if (typeof err.code === 'string' && known.includes(err.code)) {
    return `errors.${err.code}`
  }
  return 'errors.UNKNOWN'
}
