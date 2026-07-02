import http from '@/api/http'
import type { ApiResponse, PaginatedData } from '@/types'

/** 商品类型：实物 / 虚拟（需求 4.5、12.1） */
export type ProductType = 'physical' | 'virtual'

/**
 * 商品列表项（列表 / 搜索结果）。
 * - `imageUrl`：主图公开 URL；无图片时可为 null，配合 `isPlaceholder` 展示占位图（需求 4.1、4.6）。
 * - `available`：是否可兑换（上架且有货语义由后端综合判定）。
 */
export interface ProductListItem {
  id: string
  name: string
  pointsCost: number
  imageUrl: string | null
  isPlaceholder: boolean
  stock: number
  available: boolean
}

/** 商品图集项（主图 + 附图，需求 4.5） */
export interface ProductImage {
  id: string
  url: string
  isPrimary: boolean
  sortOrder: number
}

/** 商品详情（含类型、描述与完整图集，需求 4.5、4.6） */
export interface ProductDetail {
  id: string
  name: string
  description: string
  pointsCost: number
  type: ProductType
  stock: number
  available: boolean
  imageUrl: string | null
  isPlaceholder: boolean
  images: ProductImage[]
}

/** 分页查询入参 */
export interface ListParams {
  page?: number
  pageSize?: number
}

/** 搜索入参：`q` 为名称关键字（需求 4.3） */
export interface SearchParams extends ListParams {
  q: string
}

// `http.ts` 的响应拦截器返回 ApiResponse 信封（`response.data`），
// 因此运行时拿到的是 `{ code, message, data }`，需做类型断言（与 auth.ts 约定一致）。
async function get<T>(url: string, params?: Record<string, unknown>): Promise<ApiResponse<T>> {
  return (await http.get(url, { params })) as unknown as ApiResponse<T>
}

/** 分页返回上架商品（需求 4.1、4.2） */
export async function listProducts(
  params: ListParams = {},
): Promise<PaginatedData<ProductListItem>> {
  const res = await get<PaginatedData<ProductListItem>>('/products', {
    page: params.page,
    pageSize: params.pageSize,
  })
  return res.data
}

/** 名称匹配的上架商品搜索（需求 4.3、4.4） */
export async function searchProducts(
  params: SearchParams,
): Promise<PaginatedData<ProductListItem>> {
  const res = await get<PaginatedData<ProductListItem>>('/products/search', {
    q: params.q,
    page: params.page,
    pageSize: params.pageSize,
  })
  return res.data
}

/** 商品详情（含类型、图集，需求 4.5） */
export async function getProduct(id: string): Promise<ProductDetail> {
  const res = await get<ProductDetail>(`/products/${id}`)
  return res.data
}
