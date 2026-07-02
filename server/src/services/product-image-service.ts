// ProductImageService — 商品图集与主图管理（需求 12.7, 12.8, 12.9, 22.9, 22.11, 22.12）。
//
// 管理员把已直传 S3 的图片关联到商品图集，并维护主图（见设计「商品图集与主图」）。
// 本服务在应用层维护以下图集不变式（数据库部分唯一索引作为最后一道防线）：
//   - 单商品图片数 ≤ MAX_PRODUCT_IMAGES（默认 5，演示级可调，需求 22.11）：
//     `addImage` 插入前 `COUNT` 校验，超限拒绝为 `IMAGE_LIMIT_EXCEEDED`（需求 22.12）。
//   - 同一商品至多一张 `isPrimary=true`：`setPrimary` 先降级原主图再提升目标（需求 12.8）。
//   - 图集非空时恰有一张主图：首图关联时自动设为主图（需求 12.9）；删除主图后自动把
//     `sortOrder` 最小者提升为主图；`listImages` 读侧兜底——若无标记主图则自动选取
//     `sortOrder` 最小者并回写，从而恒返回恰一张主图。
//
// 所有持久化经可注入的 {@link ProductImageGateway} 接缝完成，测试可注入内存替身以
// 避免真实数据库。
//
// Requirements: 12.7, 12.8, 12.9, 22.9, 22.11, 22.12.

import { and, asc, count, eq } from 'drizzle-orm'

import { db as defaultDb, type Database } from '../db/client'
import { productImages, type NewProductImage, type ProductImage } from '../db/schema'
import { ErrorCode } from '../lib/errors'
import { HttpError } from '../middleware/http-error'

/** 默认单商品图片数上限（演示级，可经 `MAX_PRODUCT_IMAGES` 覆盖）。 */
export const DEFAULT_MAX_PRODUCT_IMAGES = 5

/** 图集视图：恰一张主图（非空时）+ 全部图片（按 sortOrder 升序）。 */
export interface GalleryView {
  /** 主图；图集为空时为 null（需求 12.9）。 */
  primary: ProductImage | null
  /** 全部图片，按 `sortOrder` 升序（同序按 `createdAt` 升序）。 */
  images: ProductImage[]
}

/**
 * 从环境变量解析单商品图片数上限；非法/缺失回退默认值。
 * （见设计「配置与环境变量」`MAX_PRODUCT_IMAGES`，默认 5。）
 */
export function resolveMaxProductImages(
  raw: string | undefined = process.env.MAX_PRODUCT_IMAGES,
): number {
  const parsed = Number(raw)
  if (Number.isInteger(parsed) && parsed > 0) return parsed
  return DEFAULT_MAX_PRODUCT_IMAGES
}

/**
 * 图集持久化接缝：计数、插入、按 id 查询、列举、主图升降级、删除。
 * 默认实现基于 Drizzle（见 {@link DrizzleProductImageGateway}），测试可注入内存替身。
 */
export interface ProductImageGateway {
  /** 统计某商品当前关联的图片数量（插入前上限校验用，需求 22.12）。 */
  count(productId: string): Promise<number>
  /** 插入一条图集图片，返回落库后的完整行。 */
  insert(row: NewProductImage): Promise<ProductImage>
  /** 按商品 + 图片 id 精确查询；不存在返回 null。 */
  findById(productId: string, imageId: string): Promise<ProductImage | null>
  /** 列举某商品全部图片，按 `sortOrder` 升序（同序按 `createdAt` 升序）。 */
  list(productId: string): Promise<ProductImage[]>
  /** 将某商品全部图片的 `isPrimary` 置 false（设新主图前降级原主图，需求 12.8）。 */
  clearPrimary(productId: string): Promise<void>
  /** 将某商品指定图片置为主图（`isPrimary=true`）。 */
  markPrimary(productId: string, imageId: string): Promise<void>
  /** 删除某商品指定图片；返回其此前是否存在。 */
  remove(productId: string, imageId: string): Promise<boolean>
}

/** 基于 Drizzle 的默认图集网关实现。 */
export class DrizzleProductImageGateway implements ProductImageGateway {
  constructor(private readonly db: Database = defaultDb) {}

  async count(productId: string): Promise<number> {
    const rows = await this.db
      .select({ value: count() })
      .from(productImages)
      .where(eq(productImages.productId, productId))
    return Number(rows[0]?.value ?? 0)
  }

  async insert(row: NewProductImage): Promise<ProductImage> {
    const inserted = await this.db.insert(productImages).values(row).returning()
    return inserted[0]
  }

  async findById(productId: string, imageId: string): Promise<ProductImage | null> {
    const rows = await this.db
      .select()
      .from(productImages)
      .where(and(eq(productImages.productId, productId), eq(productImages.id, imageId)))
      .limit(1)
    return rows[0] ?? null
  }

  async list(productId: string): Promise<ProductImage[]> {
    return this.db
      .select()
      .from(productImages)
      .where(eq(productImages.productId, productId))
      .orderBy(asc(productImages.sortOrder), asc(productImages.createdAt))
  }

  async clearPrimary(productId: string): Promise<void> {
    await this.db
      .update(productImages)
      .set({ isPrimary: false })
      .where(eq(productImages.productId, productId))
  }

  async markPrimary(productId: string, imageId: string): Promise<void> {
    await this.db
      .update(productImages)
      .set({ isPrimary: true })
      .where(and(eq(productImages.productId, productId), eq(productImages.id, imageId)))
  }

  async remove(productId: string, imageId: string): Promise<boolean> {
    const deleted = await this.db
      .delete(productImages)
      .where(and(eq(productImages.productId, productId), eq(productImages.id, imageId)))
      .returning({ id: productImages.id })
    return deleted.length > 0
  }
}

/**
 * 商品图集与主图服务（需求 12.7–12.9, 22.9, 22.11, 22.12）。
 * 依赖可注入的 {@link ProductImageGateway}；默认使用 Drizzle 实现。
 */
export class ProductImageService {
  private readonly gateway: ProductImageGateway
  private readonly maxImages: number

  constructor(options: { gateway?: ProductImageGateway; db?: Database; maxImages?: number } = {}) {
    this.gateway = options.gateway ?? new DrizzleProductImageGateway(options.db ?? defaultDb)
    this.maxImages = options.maxImages ?? resolveMaxProductImages()
  }

  /**
   * 关联一张已上传图片到商品图集（需求 12.7, 22.9, 22.11, 22.12）。
   *
   * 插入前 `COUNT` 校验：现有图片数已达上限则拒绝，不影响已有图片（需求 22.12）。
   * 首张图片自动设为主图，保证图集非空时恰有一张主图（需求 12.9）。
   *
   * @throws HttpError(IMAGE_LIMIT_EXCEEDED) 现有图片数已达 `maxImages`（默认 5）。
   */
  async addImage(productId: string, objectKey: string, url: string): Promise<ProductImage> {
    const existing = await this.gateway.count(productId)
    if (existing >= this.maxImages) {
      throw new HttpError(
        ErrorCode.ImageLimitExceeded,
        `已达到每件商品的图片数量上限（${this.maxImages} 张）`,
      )
    }

    // 首张图片自动成为主图；后续图片作为附图追加到末尾（sortOrder 递增）。
    const isPrimary = existing === 0
    const row: NewProductImage = {
      productId,
      objectKey,
      url,
      isPrimary,
      sortOrder: existing,
    }
    return this.gateway.insert(row)
  }

  /**
   * 将指定图片设为主图，原主图自动降级为附图（需求 12.8, 12.9）。
   * 先降级该商品全部图片再提升目标，保证至多一张主图。
   *
   * @returns 目标图片是否存在（不存在则未做任何变更，供路由回 404）。
   */
  async setPrimary(productId: string, imageId: string): Promise<boolean> {
    const target = await this.gateway.findById(productId, imageId)
    if (!target) return false

    await this.gateway.clearPrimary(productId)
    await this.gateway.markPrimary(productId, imageId)
    return true
  }

  /**
   * 从图集移除一张图片（需求 12.7；演示级不强制删除 S3 对象）。
   * 若删除的是主图且图集仍非空，自动把 `sortOrder` 最小者提升为主图，
   * 维持「非空图集恰一张主图」不变式（需求 12.9）。
   *
   * @returns 图片是否存在并被删除（不存在供路由回 404）。
   */
  async removeImage(productId: string, imageId: string): Promise<boolean> {
    const target = await this.gateway.findById(productId, imageId)
    if (!target) return false

    await this.gateway.remove(productId, imageId)

    if (target.isPrimary) {
      const remaining = await this.gateway.list(productId)
      if (remaining.length > 0) {
        // list 已按 sortOrder 升序，[0] 即 sortOrder 最小者。
        await this.gateway.markPrimary(productId, remaining[0].id)
      }
    }
    return true
  }

  /**
   * 列举商品图集：非空时恒返回恰一张主图（需求 12.9）。
   * 若无任何图片被标记为主图，自动选取 `sortOrder` 最小者并回写，
   * 从而无论历史数据如何，视图与库中都恰有一张主图。
   */
  async listImages(productId: string): Promise<GalleryView> {
    const images = await this.gateway.list(productId)
    if (images.length === 0) {
      return { primary: null, images }
    }

    const marked = images.find((img) => img.isPrimary)
    if (marked) {
      return { primary: marked, images }
    }

    // 无显式主图：自动选取 sortOrder 最小者（列表首项）并回写。
    const chosen = images[0]
    await this.gateway.clearPrimary(productId)
    await this.gateway.markPrimary(productId, chosen.id)
    const promoted: ProductImage = { ...chosen, isPrimary: true }
    return {
      primary: promoted,
      images: images.map((img) => (img.id === chosen.id ? promoted : img)),
    }
  }
}
