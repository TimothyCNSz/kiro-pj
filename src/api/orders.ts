import http from '@/api/http'
import type { ApiResponse, PaginatedData } from '@/types'

/** 订单类型：实物 / 虚拟（需求 7.9、8、9） */
export type OrderType = 'physical' | 'virtual'

/**
 * 订单状态：待发货 / 已发货（需求 8.4、9.3、9.4、14）。
 * - `pending_shipment`：实物未上传物流编号，或虚拟未完成虚拟发货。
 * - `shipped`：实物已上传物流编号，或虚拟已关联并可展示 CDK。
 */
export type OrderStatus = 'pending_shipment' | 'shipped'

/** 订单条目（历史列表 / 详情共用，需求 11.1） */
export interface OrderItem {
  productName: string
  quantity: number
  /** 单价（所需积分） */
  unitPoints: number
}

/** 实物订单配送地址（下单时快照，需求 8.1）；服务端以对象形式持久化并返回 */
export interface OrderAddress {
  /** 收件人姓名 */
  recipient: string
  /** 联系电话 */
  phone: string
  /** 详细配送地址 */
  detail: string
}

/** 兑换历史记录（列表项，需求 11.1、11.2） */
export interface OrderRecord {
  id: string
  type: OrderType
  /** 该订单消耗积分 */
  pointsSpent: number
  status: OrderStatus
  /** 兑换时间（ISO 字符串，历史倒序排序键，需求 11.2） */
  createdAt: string
  items: OrderItem[]
}

/**
 * 订单详情（需求 8.3、9.3、9.4）。
 * - 实物：`shippingAddress` 保存配送地址；已发货时返回 `trackingNo`（需求 8.1、8.2、8.3）。
 * - 虚拟：仅在状态为 `shipped` 时返回 `cdks`；未发货时后端不返回 CDK（需求 9.3、9.4）。
 */
export interface OrderDetail extends OrderRecord {
  /** 实物订单配送地址（需求 8.1），以对象形式返回；虚拟订单为 null（需求 9.1） */
  shippingAddress?: OrderAddress | null
  /** 实物物流编号，已发货时存在（需求 8.2、8.3） */
  trackingNo?: string | null
  /** 虚拟兑换码，仅已发货时返回（需求 9.3、9.4） */
  cdks?: string[] | null
}

/** 积分余额（需求 10.1） */
export interface BalanceData {
  balance: number
}

/** 分页查询入参 */
export interface ListOrdersParams {
  page?: number
  pageSize?: number
}

// `http.ts` 的响应拦截器返回 ApiResponse 信封（`response.data`），
// 因此运行时拿到的是 `{ code, message, data }`，需做类型断言（与其它 api 模块约定一致）。
async function get<T>(url: string, params?: Record<string, unknown>): Promise<ApiResponse<T>> {
  return (await http.get(url, { params })) as unknown as ApiResponse<T>
}

/** 查询当前可用积分余额（需求 10.1、10.2、10.3） */
export async function getBalance(): Promise<number> {
  const res = await get<BalanceData>('/points/balance')
  // 服务端保证余额非负（需求 10.3），此处仅做防御性兜底展示。
  return Math.max(0, res.data.balance)
}

/** 分页返回兑换历史（时间倒序由服务端保证，需求 11.1、11.2、11.3） */
export async function listOrders(page = 1, pageSize = 10): Promise<PaginatedData<OrderRecord>> {
  const res = await get<PaginatedData<OrderRecord>>('/orders', { page, pageSize })
  return res.data
}

/** 订单详情（实物物流 / 虚拟 CDK 视状态展示，需求 8.3、9.3、9.4） */
export async function getOrder(id: string): Promise<OrderDetail> {
  const res = await get<OrderDetail>(`/orders/${encodeURIComponent(id)}`)
  return res.data
}
