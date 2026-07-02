// CdkService — 管理员维护虚拟商品 CDK（需求 12.2, 5.1）。
//
// 管理员为虚拟商品追加用于虚拟发货的 CDK/兑换码（`POST /admin/products/:id/cdks`）。
// 新增的 CDK 以 `status='available'` 落库，从而立即计入该虚拟商品的可兑换库存
// （可用 CDK 数量即库存，需求 5.1、12.2；见 ProductStockService）。
//
// 校验（见设计「商品管理」与需求 12.2、12.6）：
//   - 仅虚拟商品可维护 CDK；实物商品不强制/不接受 CDK（需求 12.6）。
//   - 目标商品不存在或非虚拟商品 → 拒绝（`INVALID_PRODUCT_FIELD`）。
//   - 兑换码经去空白后必须至少有一个非空项，否则拒绝（`VALIDATION`）。
//
// 所有持久化经可注入的 {@link CdkGateway} 接缝完成，测试可注入内存替身以避免真实
// 数据库。
//
// Requirements: 5.1, 12.2.

import { and, count, eq } from 'drizzle-orm'

import { db as defaultDb, type Database } from '../db/client'
import { cdks, products, type NewCdk } from '../db/schema'
import { ProductType, isProductType } from '../lib/domain'
import { ErrorCode } from '../lib/errors'
import { HttpError } from '../middleware/http-error'

import { CDK_AVAILABLE } from './product-stock'

/** 新增 CDK 的结果：本次新增数量与更新后的可用 CDK 库存。 */
export interface AddCdksResult {
  /** 本次实际新增的 CDK 数量。 */
  added: number
  /** 新增后该商品的可用 CDK 数量（= 可兑换库存，需求 5.1）。 */
  availableStock: number
}

/**
 * CDK 持久化接缝：查商品类型、批量插入 available CDK、统计可用数量。
 * 默认实现基于 Drizzle（见 {@link DrizzleCdkGateway}），测试可注入内存替身。
 */
export interface CdkGateway {
  /** 返回商品类型；商品不存在返回 null。 */
  getProductType(productId: string): Promise<ProductType | null>
  /** 批量插入 `status='available'` 的 CDK 行。 */
  insertCdks(productId: string, codes: string[]): Promise<void>
  /** 统计给定商品的可用（未使用）CDK 数量。 */
  countAvailable(productId: string): Promise<number>
}

/** 基于 Drizzle 的默认 CDK 网关实现。 */
export class DrizzleCdkGateway implements CdkGateway {
  constructor(private readonly db: Database = defaultDb) {}

  async getProductType(productId: string): Promise<ProductType | null> {
    const rows = await this.db
      .select({ type: products.type })
      .from(products)
      .where(eq(products.id, productId))
      .limit(1)
    const type = rows[0]?.type
    return isProductType(type) ? type : null
  }

  async insertCdks(productId: string, codes: string[]): Promise<void> {
    const values: NewCdk[] = codes.map((code) => ({
      productId,
      code,
      status: CDK_AVAILABLE,
    }))
    await this.db.insert(cdks).values(values)
  }

  async countAvailable(productId: string): Promise<number> {
    const rows = await this.db
      .select({ value: count() })
      .from(cdks)
      .where(and(eq(cdks.productId, productId), eq(cdks.status, CDK_AVAILABLE)))
    return Number(rows[0]?.value ?? 0)
  }
}

/** 规整兑换码列表：仅接受字符串、去首尾空白、剔除空串。 */
export function normalizeCdkCodes(codes: unknown): string[] {
  if (!Array.isArray(codes)) return []
  const result: string[] = []
  for (const raw of codes) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (trimmed.length > 0) result.push(trimmed)
  }
  return result
}

/**
 * 管理员 CDK 维护服务（需求 12.2, 5.1）。
 * 依赖可注入的 {@link CdkGateway}；默认使用 Drizzle 实现。
 */
export class CdkService {
  private readonly gateway: CdkGateway

  constructor(options: { gateway?: CdkGateway; db?: Database } = {}) {
    this.gateway = options.gateway ?? new DrizzleCdkGateway(options.db ?? defaultDb)
  }

  /**
   * 为虚拟商品追加 CDK（以 `available` 落库，立即计入可兑换库存）。
   *
   * @throws HttpError(VALIDATION) 兑换码去空白后为空。
   * @throws HttpError(INVALID_PRODUCT_FIELD) 商品不存在或非虚拟商品（需求 12.2、12.6）。
   */
  async addCdks(productId: string, codes: unknown): Promise<AddCdksResult> {
    const normalized = normalizeCdkCodes(codes)
    if (normalized.length === 0) {
      throw new HttpError(ErrorCode.Validation, '请提供至少一个有效的 CDK 兑换码')
    }

    const type = await this.gateway.getProductType(productId)
    if (type === null) {
      throw new HttpError(ErrorCode.InvalidProductField, '商品不存在')
    }
    if (type !== ProductType.Virtual) {
      throw new HttpError(ErrorCode.InvalidProductField, '仅虚拟商品可维护 CDK 兑换码')
    }

    await this.gateway.insertCdks(productId, normalized)
    const availableStock = await this.gateway.countAvailable(productId)
    return { added: normalized.length, availableStock }
  }
}
