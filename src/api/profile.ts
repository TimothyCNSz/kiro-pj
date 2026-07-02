import axios from 'axios'
import http from '@/api/http'
import type { ApiResponse } from '@/types'

/**
 * 个人资料 / 头像上传 API 客户端。
 *
 * 上传遵循「签发 → 直传 → 关联」三段式（需求 22.6、22.7）：
 * 1. {@link presignAvatar} 向后端申请预签名 PUT URL（后端不中转文件内容）。
 * 2. {@link putToPresignedUrl} 用**裸 axios** 将文件字节直传至 S3；
 *    刻意不复用 `http.ts` 实例，避免带上 `Authorization` 头与 `baseURL`，
 *    也不触发其响应拦截器（需求 22.7）。
 * 3. {@link setAvatar} 将 `objectKey` 关联到当前登录员工，返回新的 `avatarUrl`（需求 23.3、23.4）。
 */

/** 允许上传的图片 MIME 类型（需求 22.2）。 */
export const ALLOWED_AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export type AllowedAvatarType = (typeof ALLOWED_AVATAR_TYPES)[number]

/** 单张图片大小上限：5MB（需求 22.3）。 */
export const MAX_AVATAR_SIZE = 5 * 1024 * 1024

/** 预签名上传结果 */
export interface PresignResult {
  /** S3 预签名 PUT URL（短时效），客户端凭此直传文件内容 */
  uploadUrl: string
  /** 生成的对象 key（如 `avatars/{userId}/{uuid}.webp`） */
  objectKey: string
  /** 关联成功后可经 CloudFront 公开读的访问 URL */
  publicUrl: string
}

/** 设置头像结果 */
export interface SetAvatarResult {
  /** 关联后当前员工的头像访问 URL */
  avatarUrl: string
}

// `http.ts` 的响应拦截器返回 ApiResponse 信封（`response.data`），需要类型断言。
async function post<T>(url: string, body?: unknown): Promise<ApiResponse<T>> {
  return (await http.post(url, body)) as unknown as ApiResponse<T>
}

/**
 * 向后端申请头像预签名上传 URL（需求 22.6）。
 * @param contentType 文件 MIME 类型（须与后续 PUT 的 Content-Type 完全一致）
 * @param size 文件字节大小
 * @param userId 当前登录员工 ID（作为 `targetId`，后端限本人）
 */
export async function presignAvatar(
  contentType: string,
  size: number,
  userId: string,
): Promise<PresignResult> {
  const res = await post<PresignResult>('/uploads/presign', {
    purpose: 'avatar',
    targetId: userId,
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

/**
 * 关联已上传对象为当前员工头像（限本人），返回新的 `avatarUrl`（需求 23.3、23.4）。
 */
export async function setAvatar(objectKey: string): Promise<SetAvatarResult> {
  const res = await post<SetAvatarResult>('/me/avatar', { objectKey })
  return res.data
}
