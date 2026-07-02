// CartService — 服务端持久化购物车（需求 6.1, 6.2, 6.4, 6.5, 6.6）。
//
// 职责（见设计「后端 API 契约」购物车分组 + Correctness Property 12）：
//   - getCart：读取当前员工的服务端购物车，返回每件商品的名称、单价（所需积分
//     pointsCost）、数量、小计（单价 × 数量）以及应付积分总额（Σ 小计）；购物车
//     持久化于服务端，跨会话/跨设备可见（需求 6.5, 6.6）。
//   - addItem：将商品加入购物车并更新数量；同一商品重复加入按数量累加（需求 6.1）。
//   - updateItem：调整某商品数量并实时重算小计与总额（需求 6.2）。
//   - removeItem：移除某条目并实时重算总额（需求 6.4）。
//
// 每位员工至多一个购物车（`carts.userId` 唯一，需求 6.6）；首次访问时惰性自动创建。
// 小计与应付总额在**每次读取与写操作后实时重算**（不落库冗余合计，恒由明细派生，
// 保证 Property 12「总额恒等于 Σ(单价 × 数量)」在任意操作序列后成立）。
//
// 设计接缝：所有持久化经可注入的 {@link CartRepository} 完成（默认基于 Drizzle），
// 测试可注入内存替身以避免真实数据库。
//
// 库存强约束（任务 7.3）：加购/改量前经注入的 {@link StockResolver} 解析该商品的
// 可兑换库存（虚拟=可用 CDK 数、实物=stock），并用 {@link assertWithinStock} 施加
//   - 零库存商品禁止加入购物车（需求 5.2）；
//   - 购物车中某商品数量不得超过其当前可兑换库存（需求 6.3）。
// 另暴露 {@link CartService.validateAgainstStock} 供结算流程（RedemptionService，
// 任务 8.x）复用「购物车数量超库存阻止结算并提示」的规则（需求 6.3）。
//
// Requirements: 6.1, 6.2, 6.4, 6.5, 6.6, 5.2, 6.3.

import { ErrorCode } from '../lib/errors'
import { HttpError } from '../middleware/http-error'
import {
  ProductStockService,
  type StockProductView,
  type StockResolver,
} from './product-stock'
import { assertWithinStock, type StockCheckItem } from './stock-guard'

/** 购物车明细中的一件商品（面向前端展示，需求 6.5）。 */
export interface CartItemView {
  /** 商品 id。 */
  productId: string
  /** 商品名称（下单前实时取自商品表）。 */
  name: string
  /** 单价：所需积分（来自 `Product.pointsCost`）。 */
  unitPoints: number
  /** 数量（恒 >= 1）。 */
  quantity: number
  /** 小计 = 单价 × 数量（需求 6.5；实时重算）。 */
  subtotal: number
}

/** 购物车视图：明细 + 应付积分总额（需求 6.5）。 */
export interface CartView {
  /** 购物车条目列表（稳定排序，便于跨会话往返一致，需求 6.6）。 */
  items: CartItemView[]
  /** 应付积分总额 = Σ 小计（需求 6.5；实时重算）。 */
  totalPoints: number
}

/** 仓储返回的一条购物车明细原始行（数量 + 关联商品的名称/单价）。 */
export interface CartLineRow {
  productId: string
  name: string
  /** 单价 = 商品所需积分（`Product.pointsCost`）。 */
  unitPoints: number
  quantity: number
}

/**
 * 购物车持久化接缝（默认 Drizzle 实现，见 {@link DrizzleCartRepository}）。
 * 仅负责原子的数据访问，合计/小计由服务层派生（保证 Property 12 可脱离 SQL 验证）。
 */
export interface CartRepository {
  /** 惰性获取/创建当前员工的购物车，返回 cartId（`carts.userId` 唯一，需求 6.6）。 */
  ensureCart(userId: string): Promise<string>
  /** 列出购物车明细（关联商品名称与单价），供派生小计/总额（需求 6.5）。 */
  listLines(cartId: string): Promise<CartLineRow[]>
  /** 查某商品在购物车中的当前数量；不在车内返回 null。 */
  findLineQuantity(cartId: string, productId: string): Promise<number | null>
  /** 新增一条购物车明细（商品尚不在车内时）。 */
  addLine(cartId: string, productId: string, quantity: number): Promise<void>
  /** 覆盖设置某商品在购物车中的数量（商品已在车内时）。 */
  setLineQuantity(cartId: string, productId: string, quantity: number): Promise<void>
  /** 从购物车移除某商品（幂等：不存在亦视为成功，需求 6.4）。 */
  removeLine(cartId: string, productId: string): Promise<void>
  /** 查商品单价（所需积分）；商品不存在返回 null（用于加购前的存在性校验）。 */
  findProductUnitPoints(productId: string): Promise<number | null>
  /**
   * 查商品的库存视图（id/type/stock），供 {@link StockResolver} 解析可兑换库存以
   * 施加零库存/超库存约束（需求 5.2, 6.3）；商品不存在返回 null。
   */
  findProductStockView(productId: string): Promise<StockProductView | null>
}

/**
 * 纯函数：从明细行派生购物车视图（小计 = 单价 × 数量，总额 = Σ 小计）。
 *
 * 无副作用，是 Property 12「总额不变式」的可独立验证核心；服务层每次读取与写
 * 操作后都经由本函数重算，保证展示的合计恒与明细一致。
 */
export function computeCartView(lines: CartLineRow[]): CartView {
  const items: CartItemView[] = lines.map((line) => ({
    productId: line.productId,
    name: line.name,
    unitPoints: line.unitPoints,
    quantity: line.quantity,
    subtotal: line.unitPoints * line.quantity,
  }))
  const totalPoints = items.reduce((sum, item) => sum + item.subtotal, 0)
  return { items, totalPoints }
}

/**
 * 校验数量为「>= 1 的整数」（需求 6 数量语义 + schema `CHECK (quantity >= 1)`）。
 * 非法数量以 `VALIDATION` 拒绝。注意：库存上限校验属于任务 7.3，不在此实现。
 */
function assertValidQuantity(quantity: unknown): asserts quantity is number {
  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) {
    throw new HttpError(ErrorCode.Validation, '商品数量必须为不小于 1 的整数')
  }
}

/** `CartService` 构造依赖（可注入以支持无副作用测试）。 */
export interface CartServiceDependencies {
  repository: CartRepository
  /**
   * 可兑换库存解析器（虚拟=可用 CDK 数、实物=stock）。用于加购/改量/结算前的库存
   * 强约束（需求 5.2, 6.3）。默认使用 {@link ProductStockService}。
   */
  stockResolver?: StockResolver
}

/**
 * CartService：服务端持久化购物车。
 *
 * 所有读取与写操作均返回**实时重算**的 {@link CartView}（小计与应付总额恒由明细
 * 派生，需求 6.2, 6.4, 6.5）。购物车按员工惰性创建并持久化于服务端（需求 6.6）。
 *
 * 库存强约束（需求 5.2, 6.3）：加购/改量前校验目标数量不超过该商品当前可兑换库存，
 * 零库存商品禁止加购；{@link validateAgainstStock} 供结算流程复用超库存拦截规则。
 */
export class CartService {
  private readonly repository: CartRepository
  private readonly stockResolver: StockResolver

  constructor(deps: CartServiceDependencies) {
    this.repository = deps.repository
    this.stockResolver = deps.stockResolver ?? new ProductStockService()
  }

  /** 读取当前员工购物车（含明细、小计与应付总额，需求 6.5, 6.6）。 */
  async getCart(userId: string): Promise<CartView> {
    const cartId = await this.repository.ensureCart(userId)
    return this.readView(cartId)
  }

  /**
   * 加入商品并更新数量（需求 6.1）。同一商品重复加入按数量累加。
   *
   * 加购前施加库存强约束（需求 5.2, 6.3）：零库存（已兑完）商品禁止加购，
   * 且累加后的总数量不得超过该商品当前可兑换库存，否则以 `INSUFFICIENT_STOCK` 拒绝。
   *
   * @throws HttpError(VALIDATION) 数量非法（非 >= 1 整数）。
   * @throws HttpError(INVALID_PRODUCT_FIELD) 商品不存在。
   * @throws HttpError(INSUFFICIENT_STOCK) 商品已兑完或累加后数量超库存。
   */
  async addItem(userId: string, productId: string, quantity: number): Promise<CartView> {
    assertValidQuantity(quantity)

    const unitPoints = await this.repository.findProductUnitPoints(productId)
    if (unitPoints === null) {
      throw new HttpError(ErrorCode.InvalidProductField, '商品不存在')
    }

    const cartId = await this.repository.ensureCart(userId)
    const existing = await this.repository.findLineQuantity(cartId, productId)
    // 加购后购物车中该商品的目标总量（重复加入按数量累加，需求 6.1）。
    const desiredQuantity = (existing ?? 0) + quantity

    // 库存强约束：零库存禁止加购、目标总量不得超库存（需求 5.2, 6.3）。
    await this.assertStock(productId, desiredQuantity)

    if (existing === null) {
      await this.repository.addLine(cartId, productId, quantity)
    } else {
      await this.repository.setLineQuantity(cartId, productId, desiredQuantity)
    }

    return this.readView(cartId)
  }

  /**
   * 调整某商品数量并实时重算小计/总额（需求 6.2）。
   *
   * 改量前施加库存强约束（需求 6.3）：新数量不得超过该商品当前可兑换库存，
   * 亦不得将已兑完商品保留在车内以待结算，否则以 `INSUFFICIENT_STOCK` 拒绝。
   *
   * @throws HttpError(VALIDATION) 数量非法（非 >= 1 整数）。
   * @throws HttpError(INVALID_PRODUCT_FIELD) 该商品不在购物车中。
   * @throws HttpError(INSUFFICIENT_STOCK) 新数量超库存或商品已兑完。
   */
  async updateItem(userId: string, productId: string, quantity: number): Promise<CartView> {
    assertValidQuantity(quantity)

    const cartId = await this.repository.ensureCart(userId)
    const existing = await this.repository.findLineQuantity(cartId, productId)
    if (existing === null) {
      throw new HttpError(ErrorCode.InvalidProductField, '该商品不在购物车中')
    }

    // 库存强约束：新数量不得超库存、已兑完不可结算（需求 6.3）。
    await this.assertStock(productId, quantity)

    await this.repository.setLineQuantity(cartId, productId, quantity)
    return this.readView(cartId)
  }

  /**
   * 结算前校验：购物车所有条目均不超其当前可兑换库存（需求 6.3）。
   *
   * 无副作用（不改动积分/库存/购物车），供兑换结算流程（RedemptionService，
   * 任务 8.x）复用「购物车数量超库存阻止结算并提示」的规则；任一条目已兑完或超
   * 库存即以 `INSUFFICIENT_STOCK` 拒绝，全部合法则返回实时重算的购物车视图。
   *
   * @throws HttpError(INSUFFICIENT_STOCK) 存在已兑完或超库存的条目。
   */
  async validateAgainstStock(userId: string): Promise<CartView> {
    const cartId = await this.repository.ensureCart(userId)
    const lines = await this.repository.listLines(cartId)

    const checks: StockCheckItem[] = await Promise.all(
      lines.map(async (line) => ({
        productId: line.productId,
        name: line.name,
        requestedQuantity: line.quantity,
        availableStock: await this.resolveStock(line.productId),
      })),
    )
    assertWithinStock(checks)

    return computeCartView(lines)
  }

  /** 从购物车移除某商品并实时重算总额（需求 6.4；幂等）。 */
  async removeItem(userId: string, productId: string): Promise<CartView> {
    const cartId = await this.repository.ensureCart(userId)
    await this.repository.removeLine(cartId, productId)
    return this.readView(cartId)
  }

  /** 从仓储明细派生购物车视图（小计与总额实时重算）。 */
  private async readView(cartId: string): Promise<CartView> {
    const lines = await this.repository.listLines(cartId)
    return computeCartView(lines)
  }

  /**
   * 解析某商品当前可兑换库存（虚拟=可用 CDK 数、实物=stock）。
   * 商品不存在时视为库存 0（已兑完），由调用方的库存约束拒绝。
   */
  private async resolveStock(productId: string): Promise<number> {
    const view = await this.repository.findProductStockView(productId)
    if (view === null) return 0
    return this.stockResolver.resolve(view)
  }

  /**
   * 断言目标数量落在商品当前可兑换库存内（需求 5.2, 6.3）。
   * 零库存（已兑完）或超库存均以 `INSUFFICIENT_STOCK` 拒绝，且不产生任何副作用。
   */
  private async assertStock(productId: string, requestedQuantity: number): Promise<void> {
    const view = await this.repository.findProductStockView(productId)
    const availableStock = view === null ? 0 : await this.stockResolver.resolve(view)
    assertWithinStock([{ productId, requestedQuantity, availableStock }])
  }
}

// ---------------------------------------------------------------------------
// Drizzle-backed default repository
// ---------------------------------------------------------------------------

import { and, asc, eq } from 'drizzle-orm'

import { db as defaultDb, type Database } from '../db/client'
import { carts, cartItems, products } from '../db/schema'

/** 基于 Drizzle 的默认购物车仓储实现（需求 6.6 服务端持久化）。 */
export class DrizzleCartRepository implements CartRepository {
  constructor(private readonly db: Database = defaultDb) {}

  async ensureCart(userId: string): Promise<string> {
    const existing = await this.db
      .select({ id: carts.id })
      .from(carts)
      .where(eq(carts.userId, userId))
      .limit(1)
    if (existing[0]) return existing[0].id

    const inserted = await this.db.insert(carts).values({ userId }).returning({ id: carts.id })
    return inserted[0].id
  }

  async listLines(cartId: string): Promise<CartLineRow[]> {
    // 关联商品表取名称与单价；稳定排序（按商品名、再按 productId）以保证往返一致。
    return this.db
      .select({
        productId: cartItems.productId,
        name: products.name,
        unitPoints: products.pointsCost,
        quantity: cartItems.quantity,
      })
      .from(cartItems)
      .innerJoin(products, eq(cartItems.productId, products.id))
      .where(eq(cartItems.cartId, cartId))
      .orderBy(asc(products.name), asc(cartItems.productId))
  }

  async findLineQuantity(cartId: string, productId: string): Promise<number | null> {
    const rows = await this.db
      .select({ quantity: cartItems.quantity })
      .from(cartItems)
      .where(and(eq(cartItems.cartId, cartId), eq(cartItems.productId, productId)))
      .limit(1)
    return rows[0]?.quantity ?? null
  }

  async addLine(cartId: string, productId: string, quantity: number): Promise<void> {
    await this.db.insert(cartItems).values({ cartId, productId, quantity })
  }

  async setLineQuantity(cartId: string, productId: string, quantity: number): Promise<void> {
    await this.db
      .update(cartItems)
      .set({ quantity })
      .where(and(eq(cartItems.cartId, cartId), eq(cartItems.productId, productId)))
  }

  async removeLine(cartId: string, productId: string): Promise<void> {
    await this.db
      .delete(cartItems)
      .where(and(eq(cartItems.cartId, cartId), eq(cartItems.productId, productId)))
  }

  async findProductUnitPoints(productId: string): Promise<number | null> {
    const rows = await this.db
      .select({ pointsCost: products.pointsCost })
      .from(products)
      .where(eq(products.id, productId))
      .limit(1)
    return rows[0]?.pointsCost ?? null
  }

  async findProductStockView(productId: string): Promise<StockProductView | null> {
    const rows = await this.db
      .select({ id: products.id, type: products.type, stock: products.stock })
      .from(products)
      .where(eq(products.id, productId))
      .limit(1)
    const row = rows[0]
    if (!row) return null
    return { id: row.id, type: row.type as StockProductView['type'], stock: row.stock }
  }
}
