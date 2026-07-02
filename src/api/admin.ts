import http from './http'
import type { ApiResponse, PaginatedData } from '@/types'

// ============================================================
// 通用请求包装：http.ts 的响应拦截器已返回 ApiResponse 信封
// （{ code, message, data }），此处解包出业务 data。
// ============================================================

async function requestData<T>(promise: Promise<unknown>): Promise<T> {
  const res = (await promise) as ApiResponse<T>
  return res.data
}

// ============================================================
// 共享领域类型
// ============================================================

export type Role = 'employee' | 'admin'
export type UserStatus = 'pending_verification' | 'active'
export type ProductType = 'physical' | 'virtual'
export type ProductStatus = 'listed' | 'unlisted'

// ============================================================
// 商品（Products）
// ============================================================

export interface Product {
  id: string
  name: string
  /** 主图公开 URL 冗余缓存，可能为空 */
  imageUrl?: string | null
  description: string
  pointsCost: number
  type: ProductType
  status: ProductStatus
  stock: number
}

export interface CreateProductRequest {
  name: string
  description?: string
  pointsCost: number
  type: ProductType
  stock: number
  status?: ProductStatus
}

export interface UpdateProductRequest {
  name?: string
  description?: string
  pointsCost?: number
  stock?: number
}

export const products = {
  /** 创建商品（校验非负积分与库存） */
  create(payload: CreateProductRequest): Promise<Product> {
    return requestData<Product>(http.post('/admin/products', payload))
  },

  /** 编辑商品 */
  update(id: string, payload: UpdateProductRequest): Promise<Product> {
    return requestData<Product>(http.put(`/admin/products/${id}`, payload))
  },

  /** 上/下架商品 */
  setStatus(id: string, status: ProductStatus): Promise<Product> {
    return requestData<Product>(http.patch(`/admin/products/${id}/status`, { status }))
  },

  /** 维护虚拟商品 CDK（追加兑换码） */
  addCdks(id: string, codes: string[]): Promise<{ added: number }> {
    return requestData<{ added: number }>(http.post(`/admin/products/${id}/cdks`, { codes }))
  },
}

// ============================================================
// 商品图集（Product Images）
// ============================================================

export interface ProductImage {
  id: string
  productId: string
  objectKey: string
  url: string
  isPrimary: boolean
  sortOrder: number
  createdAt: string
}

export interface AddProductImageRequest {
  objectKey: string
  url: string
}

export const productImages = {
  /** 关联已上传图片到该商品图集（校验 ≤5 张上限） */
  add(productId: string, payload: AddProductImageRequest): Promise<ProductImage> {
    return requestData<ProductImage>(http.post(`/admin/products/${productId}/images`, payload))
  },

  /** 将指定图片设为主图（原主图降级为附图） */
  setPrimary(productId: string, imageId: string): Promise<void> {
    return requestData<void>(http.patch(`/admin/products/${productId}/images/${imageId}/primary`))
  },

  /** 从图集移除一张图片 */
  remove(productId: string, imageId: string): Promise<void> {
    return requestData<void>(http.delete(`/admin/products/${productId}/images/${imageId}`))
  },
}

// ============================================================
// 员工列表（Users）
// ============================================================

export interface AdminUserRow {
  userId: string
  email: string
  role: Role
  status: UserStatus
  /** 来自 PointsAccount.balance，只读展示 */
  balance: number
}

export interface ListUsersParams {
  /** 按邮箱/关键字搜索；为空表示浏览全部 */
  q?: string
  page: number
  pageSize: number
}

export const users = {
  /** 分页返回员工列表（含余额），支持关键字搜索 */
  list(params: ListUsersParams): Promise<PaginatedData<AdminUserRow>> {
    return requestData<PaginatedData<AdminUserRow>>(http.get('/admin/users', { params }))
  },
}

// ============================================================
// 积分管理（Points）
// ============================================================

export interface AdjustPointsRequest {
  userId: string
  /** 正=发放，负=扣除 */
  delta: number
  note?: string
}

export interface AdjustPointsResult {
  userId: string
  newBalance: number
}

export interface BatchAdjustPointsRequest {
  userIds: string[]
  /** 正=发放，负=扣除 */
  delta: number
  note?: string
}

export interface BatchAdjustResult {
  succeeded: Array<{ userId: string; newBalance: number }>
  skipped: Array<{ userId: string; reason: 'INSUFFICIENT_BALANCE' }>
}

export const points = {
  /** 单个发放/扣除（校验不透支） */
  adjust(payload: AdjustPointsRequest): Promise<AdjustPointsResult> {
    return requestData<AdjustPointsResult>(http.post('/admin/points/adjust', payload))
  },

  /** 批量发放/扣除（部分成功） */
  batchAdjust(payload: BatchAdjustPointsRequest): Promise<BatchAdjustResult> {
    return requestData<BatchAdjustResult>(http.post('/admin/points/batch-adjust', payload))
  },
}

// ============================================================
// 发货（Fulfillment）
// ============================================================

export interface ShipPhysicalRequest {
  trackingNo: string
}

/** 物流跟踪明细节点（本阶段为演示假数据，需求 8.3） */
export interface FulfillmentTrackingNode {
  status: string
  description: string
}

/** 物流跟踪时间线（本阶段为演示假数据，需求 8.3） */
export interface FulfillmentTrackingTimeline {
  trackingNo: string
  carrier: string
  /** 从新到旧排序的物流节点 */
  nodes: FulfillmentTrackingNode[]
}

/** 实物发货结果（记录物流编号并置「已发货」，需求 8.2、14.1） */
export interface ShipPhysicalResult {
  orderId: string
  status: 'shipped'
  trackingNo: string
  tracking: FulfillmentTrackingTimeline
}

/** 虚拟发货结果（关联并交付 CDK 并置「已发货」，需求 9.4、14.2） */
export interface ShipVirtualResult {
  orderId: string
  status: 'shipped'
  /** 本次发货交付展示的 CDK 兑换码 */
  cdks: string[]
}

export const fulfillment = {
  /** 上传物流编号（实物发货，非空校验） */
  shipPhysical(orderId: string, payload: ShipPhysicalRequest): Promise<ShipPhysicalResult> {
    return requestData<ShipPhysicalResult>(
      http.post(`/admin/orders/${orderId}/ship-physical`, payload),
    )
  },

  /** 关联 CDK 虚拟发货 */
  shipVirtual(orderId: string): Promise<ShipVirtualResult> {
    return requestData<ShipVirtualResult>(http.post(`/admin/orders/${orderId}/ship-virtual`))
  },
}

// ============================================================
// 低库存提醒（Alerts）
// ============================================================

export interface LowStockAlert {
  id: string
  productId: string
  /** 库存降为 0 时生成 */
  triggeredAt: string
  /** 补货/下架后清除 */
  resolvedAt?: string | null
}

export const alerts = {
  /** 低库存提醒列表 */
  lowStock(): Promise<LowStockAlert[]> {
    return requestData<LowStockAlert[]>(http.get('/admin/alerts/low-stock'))
  },
}

// ============================================================
// 操作日志（Logs）
// ============================================================

export type OperationAction =
  | 'product_create'
  | 'product_update'
  | 'product_status'
  | 'points_grant'
  | 'points_deduct'
  | 'ship_physical'
  | 'ship_virtual'

export interface OperationLog {
  id: string
  actorId: string
  action: OperationAction
  targetType: string
  targetId: string
  /** 时间倒序展示 */
  createdAt: string
}

export interface ListLogsParams {
  page: number
  pageSize: number
}

export const logs = {
  /** 操作日志（时间倒序） */
  list(params: ListLogsParams): Promise<PaginatedData<OperationLog>> {
    return requestData<PaginatedData<OperationLog>>(http.get('/admin/logs', { params }))
  },
}

// 汇总导出，便于按需引入
export default {
  products,
  productImages,
  users,
  points,
  fulfillment,
  alerts,
  logs,
}
