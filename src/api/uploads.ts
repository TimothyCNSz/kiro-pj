import axios from 'axios'
import http from '@/api/http'
import type { ApiResponse } from '@/types'

/**
 * 通用图片上传 API 客户端（商品图集，需求 22.1–22.12）。
 *
 * 与头像上传（{@link module:@/api/profile}）一致，遵循「签发 → 直传 → 关联」三段式：
 * 1. {@link presignProductImage} 向后端申请 `purpose=product` 的预签名 PUT URL
 *    （后端不中转文件内容，需求 22.6、22.7）。商品图预签名经管理员 Guard。
 * 2. {@link putToPresignedUrl} 用**裸 axios** 将文件字节直传至 S3；刻意不复用
 *    `http.ts` 实例，避免带上 `Authorization` 头 / `baseURL` 与响应拦截器。
 * 3. 关联步骤由 `admin.productImages.add` 完成（校验 ≤5 张上限，需求 22.11、22.12）。
 */

/** 允许上传的图片 MIME 类型（需求 22.2）。 */
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number]

/** 单张图片大小上限：5MB（需求 22.3）。 */
export const MAX_IMAGE_SIZE = 5 * 1024 * 1024

/** 预签名上传结果（与后端契约对齐）。 */
export interface PresignResult {
  /** S3 预签名 PUT URL（短时效），客户端凭此直传文件内容 */
  uploadUrl: string
  /** 生成的对象 key（如 `products/{productId}/{uuid}.{ext}`） */
  objectKey: string
  /** 关联成功后可经 CloudFront 公开读的访问 URL */
  publicUrl: string
}

// `http.ts` 的响应拦截器返回 ApiResponse 信封（`response.data`），需要类型断言。
async function post<T>(url: string, body?: unknown): Promise<ApiResponse<T>> {
  return (await http.post(url, body)) as unknown as ApiResponse<T>
}

/**
 * 向后端申请商品图片预签名上传 URL（需求 22.6）。
 * @param productId 目标商品 ID（作为 `targetId`，后端经管理员 Guard 校验）
 * @param contentType 文件 MIME 类型（须与后续 PUT 的 Content-Type 完全一致）
 * @param size 文件字节大小
 */
export async function presignProductImage(
  productId: string,
  contentType: string,
  size: number,
): Promise<PresignResult> {
  const res = await post<PresignResult>('/uploads/presign', {
    purpose: 'product',
    targetId: productId,
    contentType,
    size,
  })
  return res.data
}

/**
 * 将文件字节直传至 S3 预签名 URL（需求 22.7）。
 *
 * 使用裸 axios（而非 `http.ts` 实例）：
 * - 不附加 `Authorization` 头（S3 预签名 URL 自带鉴权）；
 * - 不套用 `baseURL`（`uploadUrl` 已是完整地址）；
 * - `Content-Type` 必须与签发时声明的一致，否则 S3 依 conditions 拒绝。
 */
export async function putToPresignedUrl(uploadUrl: string, file: File): Promise<void> {
  await axios.put(uploadUrl, file, {
    headers: {
      'Content-Type': file.type,
    },
    // 覆盖可能存在的全局默认转换，直接发送二进制内容
    transformRequest: [(data) => data],
  })
}
