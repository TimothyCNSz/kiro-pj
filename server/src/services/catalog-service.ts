// CatalogService — 员工端商品浏览、搜索与详情（需求 4.1–4.6）。
//
// 职责（见设计「后端 API 契约」商品分组 + Correctness Properties 8/9）：
//   - listProducts：分页返回**仅上架**商品的列表项，每项含名称、主图（无图回退占位图）、
//     所需积分与库存/可兑换状态（需求 4.1, 4.2；Property 8/9）。
//   - searchProducts：按名称（大小写不敏感子串）匹配的上架商品；空关键字等同浏览全部
//     （需求 4.3, 4.4；Property 8）。无匹配时返回空列表，空状态提示由前端呈现（需求 4.4）。
//   - getProduct：返回商品详情，含名称、图集（主图 + 附图）、描述、所需积分、库存状态与
//     类型（实物/虚拟）；商品无任何图片时以占位图指示（需求 4.5, 4.6；Property 9）。
//
// 设计接缝（依赖可注入，测试用内存替身、不触达真实数据库）：
//   - CatalogProductRepository：商品/图集数据访问抽象（默认基于 Drizzle）。仓储在
//     SQL 层已做「仅上架 + 名称匹配 + 分页」过滤；服务层额外做一层**防御式过滤**，
//     无论仓储实现如何都恒保证输出仅含上架且匹配的商品（使 Property 8 可脱离 SQL 独立验证）。
//   - StockResolver：把商品行解析为「可兑换库存」的接缝。默认返回 `product.stock`；
//     虚拟商品的可兑换库存 = 可用 CDK 数（需求 5.1）由任务 5.4 通过注入该接缝接入，
//     本服务不重复实现 CDK 计数逻辑。
//
// Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6.

import type { PaginatedData, PaginationParams } from '../lib/api'
import { ProductStatus, type ProductType } from '../lib/domain'
import type { Product, ProductImage } from '../db/schema'

/**
 * 占位图指示 URL（需求 4.6）。商品未关联任何图片时，主图字段回退到此占位图，
 * 并置 `isPlaceholder = true` 供前端识别（实际占位素材可由前端静态资源替换）。
 */
export const PLACEHOLDER_IMAGE_URL = '/images/product-placeholder.svg'

/** 列表项（需求 4.1；Property 9 列表字段完整）。 */
export interface ProductListItem {
  id: string
  name: string
  /** 所需积分。 */
  pointsCost: number
  /** 主图 URL；无图时回退到 {@link PLACEHOLDER_IMAGE_URL}。 */
  imageUrl: string
  /** 是否以占位图展示（无关联图片，需求 4.6）。 */
  isPlaceholder: boolean
  /** 可兑换库存（经 {@link StockResolver} 解析；虚拟商品由任务 5.4 接入 CDK 计数）。 */
  stock: number
  /** 库存/可兑换状态：`stock <= 0` 视为「已兑完」（需求 5.1 语义）。 */
  available: boolean
}

/** 详情图集中的一张图片（需求 4.5）。 */
export interface ProductImageView {
  id: string
  url: string
  isPrimary: boolean
  sortOrder: number
}

/** 商品详情（需求 4.5；Property 9 详情字段完整）。 */
export interface ProductDetail {
  id: string
  name: string
  description: string
  pointsCost: number
  /** 商品类型：实物 / 虚拟（需求 4.5）。 */
  type: ProductType
  /** 可兑换库存（经 {@link StockResolver} 解析）。 */
  stock: number
  /** 库存/可兑换状态：`stock <= 0` 视为「已兑完」。 */
  available: boolean
  /** 主图 URL；无图时回退到 {@link PLACEHOLDER_IMAGE_URL}。 */
  imageUrl: string
  /** 是否以占位图展示（图集为空，需求 4.6）。 */
  isPlaceholder: boolean
  /** 完整图集（主图在前，其余按 sortOrder 升序，需求 4.5）。 */
  images: ProductImageView[]
}

/** 仓储返回的一页数据（行 + 总数）。 */
export interface ProductPage {
  rows: Product[]
  total: number
}

/**
 * 商品数据访问抽象。默认实现基于 Drizzle（{@link DrizzleCatalogProductRepository}）；
 * 测试可注入内存替身以避免真实数据库。
 */
export interface CatalogProductRepository {
  /** 分页查询「上架」商品（SQL 层已过滤 status = listed，需求 4.1, 4.2）。 */
  listListed(pagination: PaginationParams): Promise<ProductPage>
  /** 分页查询名称匹配关键字的「上架」商品（大小写不敏感，需求 4.3）。 */
  searchListedByName(keyword: string, pagination: PaginationParams): Promise<ProductPage>
  /** 按 id 精确查找商品；不存在返回 null。 */
  findById(productId: string): Promise<Product | null>
  /** 查询某商品的图集（需求 4.5）。 */
  listImages(productId: string): Promise<ProductImage[]>
}

/**
 * 库存解析接缝：给定商品行返回其「可兑换库存」。
 * 默认返回 `product.stock`；虚拟商品（= 可用 CDK 数，需求 5.1）由任务 5.4 注入实现。
 */
export type StockResolver = (product: Product) => number | Promise<number>

/** 默认库存解析：直接采用 `Product.stock`（对实物商品即权威库存）。 */
export const defaultStockResolver: StockResolver = (product) => product.stock

/** `CatalogService` 构造依赖（全部可注入以支持无副作用测试）。 */
export interface CatalogServiceDependencies {
  repository: CatalogProductRepository
  /** 库存解析接缝（缺省 {@link defaultStockResolver}）。 */
  stockResolver?: StockResolver
  /** 占位图 URL（缺省 {@link PLACEHOLDER_IMAGE_URL}）。 */
  placeholderUrl?: string
}

/** 大小写不敏感子串匹配（空关键字视为匹配一切，即「浏览」语义）。 */
function nameMatches(name: string, keyword: string): boolean {
  const q = keyword.trim().toLowerCase()
  if (q.length === 0) return true
  return name.toLowerCase().includes(q)
}

/**
 * CatalogService：员工端商品浏览、搜索与详情。
 *
 * 服务层对仓储返回的行做防御式过滤（仅上架 + 名称匹配），无论仓储实现如何都恒
 * 满足 Property 8；并将行映射为面向前端的 DTO（解析主图/占位图、库存状态）。
 */
export class CatalogService {
  private readonly repository: CatalogProductRepository
  private readonly stockResolver: StockResolver
  private readonly placeholderUrl: string

  constructor(deps: CatalogServiceDependencies) {
    this.repository = deps.repository
    this.stockResolver = deps.stockResolver ?? defaultStockResolver
    this.placeholderUrl = deps.placeholderUrl ?? PLACEHOLDER_IMAGE_URL
  }

  /** 分页返回仅上架商品的列表项（需求 4.1, 4.2）。 */
  async listProducts(pagination: PaginationParams): Promise<PaginatedData<ProductListItem>> {
    const page = await this.repository.listListed(pagination)
    return this.toListPage(page, pagination, '')
  }

  /**
   * 分页返回名称匹配关键字的上架商品（需求 4.3, 4.4）。
   * 空关键字等同浏览全部上架商品（Property 8「空关键字表示浏览」）。
   */
  async searchProducts(
    keyword: string,
    pagination: PaginationParams,
  ): Promise<PaginatedData<ProductListItem>> {
    const normalized = typeof keyword === 'string' ? keyword.trim() : ''
    const page =
      normalized.length === 0
        ? await this.repository.listListed(pagination)
        : await this.repository.searchListedByName(normalized, pagination)
    return this.toListPage(page, pagination, normalized)
  }

  /** 返回商品详情（含图集与类型）；商品不存在返回 null（需求 4.5, 4.6）。 */
  async getProduct(productId: string): Promise<ProductDetail | null> {
    const product = await this.repository.findById(productId)
    if (!product) return null

    const images = await this.repository.listImages(productId)
    const gallery = this.orderGallery(images)
    const primary = gallery[0]
    const stock = await Promise.resolve(this.stockResolver(product))
    const hasImage = gallery.length > 0

    return {
      id: product.id,
      name: product.name,
      description: product.description,
      pointsCost: product.pointsCost,
      type: product.type as ProductType,
      stock,
      available: stock > 0,
      imageUrl: primary?.url ?? product.imageUrl ?? this.placeholderUrl,
      isPlaceholder: !hasImage && !product.imageUrl,
      images: gallery,
    }
  }

  /** 防御式过滤 + 映射为列表页 DTO。 */
  private async toListPage(
    page: ProductPage,
    pagination: PaginationParams,
    keyword: string,
  ): Promise<PaginatedData<ProductListItem>> {
    // 防御式不变式：无论仓储实现如何，输出仅含上架且（关键字为空或名称匹配）的商品（Property 8）。
    const filtered = page.rows.filter(
      (p) => p.status === ProductStatus.Listed && nameMatches(p.name, keyword),
    )
    const list = await Promise.all(filtered.map((p) => this.toListItem(p)))
    return {
      list,
      total: page.total,
      page: pagination.page,
      pageSize: pagination.pageSize,
    }
  }

  /** 单个商品行 → 列表项（解析主图/占位图与库存状态）。 */
  private async toListItem(product: Product): Promise<ProductListItem> {
    const stock = await Promise.resolve(this.stockResolver(product))
    const hasImage = typeof product.imageUrl === 'string' && product.imageUrl.length > 0
    return {
      id: product.id,
      name: product.name,
      pointsCost: product.pointsCost,
      imageUrl: hasImage ? (product.imageUrl as string) : this.placeholderUrl,
      isPlaceholder: !hasImage,
      stock,
      available: stock > 0,
    }
  }

  /** 图集排序：主图在前，其余按 sortOrder 升序（并列时按 id 稳定）。 */
  private orderGallery(images: ProductImage[]): ProductImageView[] {
    return [...images]
      .sort((a, b) => {
        if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
        return a.id.localeCompare(b.id)
      })
      .map((img) => ({
        id: img.id,
        url: img.url,
        isPrimary: img.isPrimary,
        sortOrder: img.sortOrder,
      }))
  }
}

// ---------------------------------------------------------------------------
// Drizzle-backed default repository
// ---------------------------------------------------------------------------

import { and, asc, count, eq, ilike } from 'drizzle-orm'

import { db as defaultDb, type Database } from '../db/client'
import { products, productImages } from '../db/schema'

/** 计算 SQL LIMIT/OFFSET（page 从 1 起，非法值回退安全默认）。 */
function toLimitOffset(pagination: PaginationParams): { limit: number; offset: number } {
  const page = Number.isFinite(pagination.page) && pagination.page > 0 ? Math.floor(pagination.page) : 1
  const pageSize =
    Number.isFinite(pagination.pageSize) && pagination.pageSize > 0
      ? Math.floor(pagination.pageSize)
      : 20
  return { limit: pageSize, offset: (page - 1) * pageSize }
}

/** 转义 ILIKE 通配符，使关键字按字面量子串匹配。 */
function escapeLike(keyword: string): string {
  return keyword.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/** 基于 Drizzle 的默认商品仓储实现。 */
export class DrizzleCatalogProductRepository implements CatalogProductRepository {
  constructor(private readonly db: Database = defaultDb) {}

  async listListed(pagination: PaginationParams): Promise<ProductPage> {
    const { limit, offset } = toLimitOffset(pagination)
    const where = eq(products.status, ProductStatus.Listed)
    const rows = await this.db
      .select()
      .from(products)
      .where(where)
      .orderBy(asc(products.createdAt))
      .limit(limit)
      .offset(offset)
    const [totalRow] = await this.db.select({ value: count() }).from(products).where(where)
    return { rows, total: totalRow?.value ?? 0 }
  }

  async searchListedByName(keyword: string, pagination: PaginationParams): Promise<ProductPage> {
    const { limit, offset } = toLimitOffset(pagination)
    const pattern = `%${escapeLike(keyword.trim())}%`
    const where = and(eq(products.status, ProductStatus.Listed), ilike(products.name, pattern))
    const rows = await this.db
      .select()
      .from(products)
      .where(where)
      .orderBy(asc(products.createdAt))
      .limit(limit)
      .offset(offset)
    const [totalRow] = await this.db.select({ value: count() }).from(products).where(where)
    return { rows, total: totalRow?.value ?? 0 }
  }

  async findById(productId: string): Promise<Product | null> {
    const rows = await this.db.select().from(products).where(eq(products.id, productId)).limit(1)
    return rows[0] ?? null
  }

  async listImages(productId: string): Promise<ProductImage[]> {
    return this.db
      .select()
      .from(productImages)
      .where(eq(productImages.productId, productId))
      .orderBy(asc(productImages.sortOrder))
  }
}
