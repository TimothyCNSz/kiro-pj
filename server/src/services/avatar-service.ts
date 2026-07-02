// AvatarService — 员工头像关联与展示回退（需求 22.9, 23.1, 23.2, 23.3, 23.4）。
//
// 职责（见设计「图片上传与存储 · 默认头像」与 AvatarService 接口）：
//   - setAvatar：将一个**已直传到 S3 的对象**（objectKey）关联为某员工的头像。
//     由 objectKey 派生公开访问 URL（经 CloudFront，需求 22.10），写入
//     `User.avatarUrl` 并返回新的 `avatarUrl`（需求 22.9، 23.3، 23.4）。本服务只
//     负责「关联到给定 userId」——「限本人」由路由层用 `req.user.userId` 强制
//     （员工只能改自己的头像，见 me-avatar 路由，需求 23.3）。
//   - resolveAvatarUrl：解析展示用头像 URL。`avatarUrl` 为空（null / 纯空白）时
//     回退到统一的默认头像 URL（需求 23.2）；非空则原样返回（需求 23.4）。
//
// 设计接缝：持久化经可注入的 {@link AvatarRepository}（默认基于 Drizzle），URL 构造
// 经可注入的 `buildUrl`（默认 `buildPublicUrl`）。二者均可在测试中以替身注入，从而
// 不触达真实数据库与 AWS。构造无副作用（数据库连接惰性建立）。
//
// Requirements: 22.9, 23.1, 23.2, 23.3, 23.4.

import { buildPublicUrl } from './s3-presign'

/**
 * 统一默认头像 URL（需求 23.2）：员工未设置头像时展示。可经 `AVATAR_DEFAULT_URL`
 * 覆盖为约定的公开 URL；缺省指向前端内置的默认头像静态资源。
 */
export const DEFAULT_AVATAR_URL = process.env.AVATAR_DEFAULT_URL ?? '/assets/default-avatar.png'

/**
 * 头像持久化接缝（默认 Drizzle 实现，见 {@link DrizzleAvatarRepository}）。
 * 仅负责把某用户的 `avatarUrl` 覆盖为给定值。
 */
export interface AvatarRepository {
  /** 覆盖设置某用户的头像 URL（需求 22.9, 23.3, 23.4）。 */
  setAvatarUrl(userId: string, avatarUrl: string): Promise<void>
}

/** 由 objectKey 构造公开访问 URL 的函数接缝（缺省 `buildPublicUrl`，需求 22.10）。 */
export type PublicUrlBuilder = (objectKey: string) => string

/** `AvatarService` 构造依赖（可注入以支持无副作用测试）。 */
export interface AvatarServiceDependencies {
  repository: AvatarRepository
  /** objectKey → 公开 URL 的构造器（缺省 `buildPublicUrl`）。 */
  buildUrl?: PublicUrlBuilder
}

/**
 * 判断 `avatarUrl` 是否为「已设置」：非 null 且去除首尾空白后非空。
 * 纯空白视为未设置，触发默认头像回退（需求 23.2）。
 */
function hasAvatar(avatarUrl: string | null | undefined): avatarUrl is string {
  return typeof avatarUrl === 'string' && avatarUrl.trim().length > 0
}

/**
 * AvatarService：员工头像关联与展示回退。
 *
 * `setAvatar` 把已上传对象关联为员工头像（需求 22.9, 23.3）；`resolveAvatarUrl`
 * 在未设置时回退默认头像、设置后返回所设 URL（需求 23.2, 23.4）。
 */
export class AvatarService {
  private readonly repository: AvatarRepository
  private readonly buildUrl: PublicUrlBuilder

  constructor(deps: AvatarServiceDependencies) {
    this.repository = deps.repository
    this.buildUrl = deps.buildUrl ?? ((objectKey) => buildPublicUrl(objectKey))
  }

  /**
   * 将已直传的对象关联为该员工头像并返回新的 `avatarUrl`（需求 22.9, 23.3, 23.4）。
   * 「限本人」由路由层保证（此处只作用于给定 userId）。
   */
  async setAvatar(userId: string, objectKey: string): Promise<{ avatarUrl: string }> {
    const avatarUrl = this.buildUrl(objectKey)
    await this.repository.setAvatarUrl(userId, avatarUrl)
    return { avatarUrl }
  }

  /**
   * 解析展示用头像 URL：`avatarUrl` 为空（未设置）回退默认头像（需求 23.2），
   * 否则返回所设 URL（需求 23.4）。纯函数、无副作用。
   */
  resolveAvatarUrl(user: { avatarUrl: string | null }): string {
    return hasAvatar(user.avatarUrl) ? user.avatarUrl : DEFAULT_AVATAR_URL
  }
}

// ---------------------------------------------------------------------------
// Drizzle-backed default repository
// ---------------------------------------------------------------------------

import { eq } from 'drizzle-orm'

import { db as defaultDb, type Database } from '../db/client'
import { users } from '../db/schema'

/** 基于 Drizzle 的默认头像仓储实现（需求 22.9, 23.3）。 */
export class DrizzleAvatarRepository implements AvatarRepository {
  constructor(private readonly db: Database = defaultDb) {}

  async setAvatarUrl(userId: string, avatarUrl: string): Promise<void> {
    await this.db.update(users).set({ avatarUrl }).where(eq(users.id, userId))
  }
}
