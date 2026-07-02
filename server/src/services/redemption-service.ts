// RedemptionService — 兑换（结算）事务核心（需求 7.4, 7.8, 7.10, 19.2, 19.4）。
//
// 本模块实现「单次兑换事务的原子一致性」这一强约束（需求 7.8、19.2）：一次兑换的
// 积分扣除与所有商品库存扣减在**同一数据库事务**内整体成功或整体失败，绝不产生部
// 分扣减。跨请求并发下的防超卖/防透支为**演示级尽力而为**（需求 7.10、19.4）——以
// 行锁（悲观）+ 版本条件更新（乐观）作为实现手段，但不承诺高并发强 SLA。
//
// 事务体（见设计「兑换事务」Drizzle 示意）：
//   1. 以**稳定顺序**锁行防死锁：先锁积分账户，再按 `productId` 升序 `FOR UPDATE`
//      锁定各商品行（含 `version`）。
//   2. 校验：余额 >= 应付总额（否则 INSUFFICIENT_POINTS）、每商品请求数量 <= 库存
//      （否则 INSUFFICIENT_STOCK）；任一校验失败即 throw → 整体回滚、无任何扣减。
//   3. 版本条件更新库存：`UPDATE ... WHERE id=? AND version=?` 相对扣减
//      （`stock = stock - qty`, `version = version + 1`）；影响行数为 0 视为并发修改
//      （{@link ConcurrencyConflictError}）→ 回滚并**有限次重试**（需求 7.10、19.4）。
//   4. 相对扣减积分余额（`balance = balance - totalCost`，`balance >= 0` 由 DB
//      `CHECK` 约束兜底，见 schema）。
//
// 扩展接缝（本任务只实现事务核心，后续任务经 {@link RedemptionHooks} 无侵入扩展）：
//   - 任务 8.4：`preValidate` —— 无副作用的前置校验（含实物缺地址等），在任何扣减
//     之前 throw 即整体回滚。
//   - 任务 8.6：`applyEffects` —— 事务内按类型拆分生成实物/虚拟订单、订单项归类。
//   - 任务 8.9：`applyEffects` —— 事务内消耗 CDK、记积分流水、移除购物车已兑项、
//     对降为 0 的库存触发低库存提醒。
//
// 数据访问经可注入的 {@link RedemptionStore} 接缝完成：默认基于 Drizzle 的
// `db.transaction` + `.for('update')` + 版本条件更新（{@link DrizzleRedemptionStore}），
// 测试可注入内存事务替身以脱离真实 PostgreSQL 验证原子性、重试与相对扣减。
//
// Requirements: 7.4, 7.8, 7.10, 19.2, 19.4.

import { ErrorCode } from '../lib/errors'
import { HttpError } from '../middleware/http-error'
import { OrderType, ProductType } from '../lib/domain'
import { assertWithinStock, type StockCheckItem } from './stock-guard'

// ---------------------------------------------------------------------------
// Concurrency conflict error (需求 7.10, 19.4)
// ---------------------------------------------------------------------------

/**
 * 并发版本冲突：版本条件库存更新影响行数为 0，说明另一并发事务已修改该商品行。
 * 映射到 {@link ErrorCode.ConcurrencyConflict}（HTTP 409）。事务核心据此回滚并做
 * 有限次重试；重试仍冲突则最终抛出（由统一错误中间件序列化为 409）。
 */
export class ConcurrencyConflictError extends HttpError {
  constructor(message = '兑换处理发生并发冲突，请稍后重试') {
    super(ErrorCode.ConcurrencyConflict, message)
    this.name = 'ConcurrencyConflictError'
    // Restore prototype chain for `instanceof` under transpilation targets.
    Object.setPrototypeOf(this, ConcurrencyConflictError.prototype)
  }
}

// ---------------------------------------------------------------------------
// Public request / result shapes
// ---------------------------------------------------------------------------

/** 一件待兑换商品（结算或立即兑换的输入项）。 */
export interface RedeemItem {
  /** 商品 id。 */
  productId: string
  /** 兑换数量（须为 >= 1 的整数）。 */
  quantity: number
}

/**
 * 配送地址（实物兑换需要，需求 7.3、8.1）。本任务的事务核心不校验其内容——
 * 地址必填校验属于任务 8.4（经 {@link RedemptionHooks.preValidate} 接入），
 * 持久化属于任务 8.9；此处仅作为上下文透传给后续接缝。
 */
export interface Address {
  recipient: string
  phone: string
  detail: string
  [key: string]: unknown
}

/** 兑换选项（可含实物配送地址）。 */
export interface CheckoutOptions {
  address?: Address
}

// ---------------------------------------------------------------------------
// Transactional store seam (default: Drizzle; tests: in-memory fake)
// ---------------------------------------------------------------------------

/** 被 `FOR UPDATE` 锁定的积分账户视图（含乐观锁版本号）。 */
export interface LockedAccount {
  userId: string
  balance: number
  version: number
}

/** 被 `FOR UPDATE` 锁定的商品行视图（含乐观锁版本号）。 */
export interface LockedProduct {
  id: string
  name: string
  type: ProductType
  /** 单价：所需积分（`Product.pointsCost`）。 */
  pointsCost: number
  /** 当前库存（实物=stock 字段；虚拟商品的 CDK 消耗由任务 8.9 集成）。 */
  stock: number
  /** 乐观锁版本号，用于版本条件更新（需求 7.10、19.4）。 */
  version: number
}

/** 事务内新建订单的入参（任务 8.9；对应 schema `orders`）。 */
export interface NewOrderInput {
  /** 下单员工。 */
  userId: string
  /** 订单类型：实物 / 虚拟（需求 7.9）。 */
  type: OrderType
  /** 该订单消耗积分（= 归属该订单各项 `unitPoints × quantity` 之和）。 */
  pointsSpent: number
  /** 配送地址（仅实物订单持久化，需求 8.1）；虚拟订单为 null（需求 9.1）。 */
  shippingAddress?: Address | null
}

/** 事务内新建订单项的入参（任务 8.9；对应 schema `order_items`，含下单快照）。 */
export interface NewOrderItemInput {
  /** 商品 id。 */
  productId: string
  /** 下单时的商品名称快照。 */
  productName: string
  /** 兑换数量。 */
  quantity: number
  /** 下单时的单价快照（所需积分）。 */
  unitPoints: number
}

/** 事务内新增积分流水的入参（任务 8.9；对应 schema `points_ledger`）。 */
export interface NewPointsLedgerInput {
  /** 流水归属员工。 */
  userId: string
  /** 积分变化量（兑换为负值 = -应付总额）。 */
  delta: number
  /** 变更原因（本任务恒为兑换）。 */
  reason: 'redemption'
  /** 可选备注。 */
  note?: string | null
  /** 变更后的余额（= 扣减前余额 + delta），维系「余额 = 流水累积」（需求 10.2、20.2）。 */
  balanceAfter: number
}

/**
 * 单次兑换事务内的数据访问句柄。默认实现基于 Drizzle 事务
 * （{@link DrizzleRedemptionTx}），全部操作运行在同一事务边界内，随事务整体提交
 * 或回滚（需求 7.8、19.2）。
 *
 * 除锁行与相对扣减（本核心）外，还提供任务 8.9 兑换副作用所需的事务内写操作：
 * 生成订单/订单项、消耗虚拟 CDK、记积分流水、移除购物车已兑项，以及暴露底层
 * 事务/数据库句柄（{@link RedemptionTx.handle}）供参与同一事务的其他服务
 * （如 AlertService 的低库存提醒去重写入）复用。
 */
export interface RedemptionTx {
  /** `SELECT ... FOR UPDATE` 锁定并读取员工积分账户；不存在返回 null。 */
  lockPointsAccount(userId: string): Promise<LockedAccount | null>
  /**
   * 按 `productId` **升序** `SELECT ... FOR UPDATE` 锁定并读取给定商品行（防死锁，
   * 见设计「锁的获取顺序固定」）。仅返回存在的商品行。
   */
  lockProductsAscending(productIds: readonly string[]): Promise<LockedProduct[]>
  /**
   * 版本条件相对扣减库存：`UPDATE ... SET stock = stock - qty, version = version + 1
   * WHERE id = ? AND version = expectedVersion`。返回受影响行数：为 0 表示版本不匹配
   * （并发修改），调用方据此抛 {@link ConcurrencyConflictError}（需求 7.10、19.4）。
   */
  decrementProductStock(
    productId: string,
    quantity: number,
    expectedVersion: number,
  ): Promise<number>
  /**
   * 相对扣减积分余额：`UPDATE ... SET balance = balance - amount, version = version + 1
   * WHERE userId = ?`。账户已被 `FOR UPDATE` 锁定，无需版本条件；`balance >= 0` 由
   * DB `CHECK` 约束兜底（需求 10.3）。
   */
  decrementBalance(userId: string, amount: number): Promise<void>
  /**
   * 事务内插入一条订单，返回新订单 id（任务 8.9，需求 7.4、7.9）。
   */
  insertOrder(order: NewOrderInput): Promise<string>
  /**
   * 事务内批量插入某订单的订单项（任务 8.9）；空数组为无操作。
   */
  insertOrderItems(orderId: string, items: readonly NewOrderItemInput[]): Promise<void>
  /**
   * 事务内消耗某虚拟商品的 `quantity` 个可用 CDK（每虚拟单位消耗 1 个，需求 9.2），
   * 将其置为 `consumed` 并关联到 `orderId`。可用 CDK 不足则抛 INSUFFICIENT_STOCK
   * （正常流程已在锁定/校验阶段拦截，此为一致性兜底）。
   */
  consumeCdks(productId: string, quantity: number, orderId: string): Promise<void>
  /**
   * 事务内新增一条积分流水（任务 8.9，需求 10.2、13.6、20.2）。
   */
  insertPointsLedger(entry: NewPointsLedgerInput): Promise<void>
  /**
   * 事务内从该员工购物车移除给定商品条目（需求 7.5）；幂等：无购物车或条目不存在
   * 均视为成功。空数组为无操作。
   */
  removeCartItems(userId: string, productIds: readonly string[]): Promise<void>
  /**
   * 底层事务/数据库句柄，供参与**同一事务**的其他服务复用（如 AlertService 的低库存
   * 提醒去重写入，任务 8.9/12.3）。默认实现返回 Drizzle 事务对象；类型为 `unknown`
   * 以避免核心耦合具体持久化类型，由调用方按需传递。
   */
  readonly handle: unknown
}

/**
 * 兑换事务接缝：以单个数据库事务运行 `fn`，`fn` 抛错即整体回滚（需求 7.8、19.2）。
 * 默认基于 Drizzle 的 `db.transaction`（见 {@link DrizzleRedemptionStore}）；
 * 测试可注入内存事务替身。
 */
export interface RedemptionStore {
  transaction<T>(fn: (tx: RedemptionTx) => Promise<T>): Promise<T>
}

// ---------------------------------------------------------------------------
// Redemption context / result (shared with future-task hooks)
// ---------------------------------------------------------------------------

/** 兑换明细行：请求项 + 锁定的商品信息 + 该行应付积分。 */
export interface RedemptionLine {
  productId: string
  quantity: number
  /** 该商品被锁定时的行视图（含单价、库存、版本、类型）。 */
  product: LockedProduct
  /** 该行应付积分 = 单价 × 数量。 */
  cost: number
}

/**
 * 兑换事务上下文，在锁行与校验完成后构建，透传给扩展接缝
 * （{@link RedemptionHooks}）。供任务 8.4（前置校验）、8.6（拆单）、8.9（副作用）
 * 使用，无需触碰核心逻辑。
 */
export interface RedemptionContext {
  userId: string
  /** 锁定的积分账户（扣减前视图）。 */
  account: LockedAccount
  /** 兑换明细行（按 `productId` 升序，与锁定顺序一致）。 */
  lines: RedemptionLine[]
  /** 应付积分总额 = Σ 各行 cost。 */
  totalCost: number
  /** 配送地址（若提供），供实物相关接缝使用。 */
  address?: Address
}

/** 兑换事务核心的返回结果（供上层构建响应 / 供未来任务补充订单等）。 */
export interface CheckoutResult {
  userId: string
  lines: RedemptionLine[]
  totalCost: number
  /** 扣减前余额。 */
  balanceBefore: number
  /** 扣减后余额（= balanceBefore - totalCost）。 */
  balanceAfter: number
}

/**
 * 兑换事务扩展接缝（无侵入 hook）。后续任务经此在**同一事务内**接入其逻辑，
 * 核心保持稳定：
 *   - {@link preValidate}：任务 8.4，无副作用的前置校验（如实物缺地址）。在任何
 *     库存/积分扣减之前调用，抛错即整体回滚且不产生副作用。
 *   - {@link applyEffects}：任务 8.6/8.9，在积分/库存扣减之后、仍在事务内执行的
 *     副作用（按类型拆单生成订单/订单项、消耗 CDK、记积分流水、移除购物车已兑项、
 *     触发低库存提醒）。抛错同样整体回滚（原子性延伸至副作用）。
 */
export interface RedemptionHooks {
  preValidate?(ctx: RedemptionContext): void | Promise<void>
  applyEffects?(ctx: RedemptionContext, tx: RedemptionTx): void | Promise<void>
}

/** `RedemptionService` 构造依赖。 */
export interface RedemptionServiceDependencies {
  /** 事务接缝（默认 {@link DrizzleRedemptionStore}）。 */
  store?: RedemptionStore
  /** 扩展接缝（任务 8.4/8.6/8.9 注入）。 */
  hooks?: RedemptionHooks
  /** 并发冲突的最大重试次数（演示级尽力而为，默认 3）。 */
  maxRetries?: number
}

/** 默认并发冲突重试次数（演示级；需求 7.10、19.4 尽力而为）。 */
const DEFAULT_MAX_RETRIES = 3

// ---------------------------------------------------------------------------
// RedemptionService
// ---------------------------------------------------------------------------

/**
 * RedemptionService：单事务兑换核心。
 *
 * `checkout` 将整个兑换封装在一个数据库事务内（经 {@link RedemptionStore}）：稳定
 * 顺序锁行 → 校验余额/库存 → 版本条件相对扣减库存 → 相对扣减积分。任一步抛错整体
 * 回滚（原子性，需求 7.8、19.2）；库存版本条件更新影响行数为 0 视为并发冲突，回滚
 * 并有限次重试（演示级尽力而为，需求 7.10、19.4）。
 */
export class RedemptionService {
  private readonly store: RedemptionStore
  private readonly hooks: RedemptionHooks
  private readonly maxRetries: number

  constructor(deps: RedemptionServiceDependencies = {}) {
    this.store = deps.store ?? new DrizzleRedemptionStore()
    this.hooks = deps.hooks ?? {}
    this.maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES
  }

  /**
   * 执行一次兑换（结算 / 立即兑换共用核心，需求 7.4、7.8）。
   *
   * @param userId 兑换发起员工。
   * @param items  待兑换商品项（同一商品重复项按数量合并）。
   * @param options 兑换选项（可含实物配送地址，透传给接缝）。
   * @returns 兑换结果（明细、应付总额、扣减前后余额）。
   * @throws HttpError(VALIDATION) items 为空或数量非法。
   * @throws HttpError(INVALID_PRODUCT_FIELD) 存在不存在的商品。
   * @throws HttpError(INSUFFICIENT_POINTS) 余额不足以支付应付总额（需求 7.4、5.4）。
   * @throws HttpError(INSUFFICIENT_STOCK) 任一商品请求数量超过库存（需求 5.5、7）。
   * @throws ConcurrencyConflictError 重试仍存在并发版本冲突（需求 7.10、19.4）。
   */
  async checkout(
    userId: string,
    items: readonly RedeemItem[],
    options: CheckoutOptions = {},
  ): Promise<CheckoutResult> {
    const normalized = normalizeItems(items)

    // 有限次重试：并发版本冲突回滚后重试（需求 7.10、19.4）。其余错误立即抛出。
    let attempt = 0
    for (;;) {
      try {
        return await this.store.transaction((tx) =>
          this.runCheckout(tx, userId, normalized, options.address),
        )
      } catch (err) {
        if (err instanceof ConcurrencyConflictError && attempt < this.maxRetries) {
          attempt += 1
          continue
        }
        throw err
      }
    }
  }

  /**
   * 单次事务体（可能被重试多次调用；每次都在全新事务内重新锁行读取最新版本）。
   */
  private async runCheckout(
    tx: RedemptionTx,
    userId: string,
    items: RedeemItem[],
    address: Address | undefined,
  ): Promise<CheckoutResult> {
    // 1) 稳定顺序锁行防死锁：先积分账户，再商品按 productId 升序（需求 7.10）。
    const account = await tx.lockPointsAccount(userId)
    if (account === null) {
      throw new HttpError(ErrorCode.InsufficientPoints, '积分账户不存在或积分不足')
    }

    const sortedIds = items.map((it) => it.productId).sort()
    const locked = await tx.lockProductsAscending(sortedIds)
    const byId = new Map(locked.map((p) => [p.id, p]))

    // 构建兑换明细（保持 productId 升序，与锁定顺序一致）。
    const lines: RedemptionLine[] = sortedIds.map((productId) => {
      const product = byId.get(productId)
      if (!product) {
        throw new HttpError(ErrorCode.InvalidProductField, `商品不存在：${productId}`)
      }
      const quantity = items.find((it) => it.productId === productId)!.quantity
      return { productId, quantity, product, cost: product.pointsCost * quantity }
    })
    const totalCost = lines.reduce((sum, line) => sum + line.cost, 0)

    const ctx: RedemptionContext = { userId, account, lines, totalCost, address }

    // 2a) 扩展前置校验接缝（任务 8.4）：无副作用，抛错在任何扣减前整体回滚。
    await this.hooks.preValidate?.(ctx)

    // 2b) 核心校验（本任务）：余额 >= 应付总额；每商品请求数量 <= 库存。
    //     失败即 throw → 整体回滚、无任何扣减（需求 7.4、7.8、5.4、5.5）。
    assertSufficientPoints(account, totalCost)
    assertSufficientStock(lines)

    // 3) 版本条件相对扣减库存：影响行数为 0 视为并发修改 → 回滚重试（需求 7.10、19.4）。
    for (const line of lines) {
      const affected = await tx.decrementProductStock(
        line.productId,
        line.quantity,
        line.product.version,
      )
      if (affected === 0) {
        throw new ConcurrencyConflictError()
      }
    }

    // 4) 相对扣减积分余额（balance >= 0 由 DB CHECK 兜底，需求 10.3）。
    await tx.decrementBalance(userId, totalCost)

    // 5) 副作用扩展接缝（任务 8.6 拆单 / 8.9 CDK·流水·购物车·低库存提醒），仍在事务内。
    await this.hooks.applyEffects?.(ctx, tx)

    return {
      userId,
      lines,
      totalCost,
      balanceBefore: account.balance,
      balanceAfter: account.balance - totalCost,
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (无副作用，便于独立验证)
// ---------------------------------------------------------------------------

/**
 * 归一化兑换项：校验非空、数量为 >= 1 的整数，并合并同一商品的重复项（数量累加）。
 * 返回按 `productId` 升序排列的明细，便于稳定锁定顺序。
 */
export function normalizeItems(items: readonly RedeemItem[]): RedeemItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new HttpError(ErrorCode.Validation, '兑换商品项不能为空')
  }
  const merged = new Map<string, number>()
  for (const item of items) {
    if (typeof item.productId !== 'string' || item.productId.length === 0) {
      throw new HttpError(ErrorCode.Validation, '兑换商品项缺少有效的 productId')
    }
    if (
      typeof item.quantity !== 'number' ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1
    ) {
      throw new HttpError(ErrorCode.Validation, '兑换数量必须为不小于 1 的整数')
    }
    merged.set(item.productId, (merged.get(item.productId) ?? 0) + item.quantity)
  }
  return [...merged.entries()]
    .map(([productId, quantity]) => ({ productId, quantity }))
    .sort((a, b) => a.productId.localeCompare(b.productId))
}

/** 断言余额足以支付应付总额，否则以 INSUFFICIENT_POINTS 拒绝（需求 7.4、5.4）。 */
export function assertSufficientPoints(account: LockedAccount, totalCost: number): void {
  if (account.balance < totalCost) {
    throw new HttpError(ErrorCode.InsufficientPoints, '积分不足')
  }
}

/**
 * 断言每商品请求数量均不超过其锁定库存，否则以 INSUFFICIENT_STOCK 拒绝
 * （复用 {@link assertWithinStock}，需求 5.5、7）。
 */
export function assertSufficientStock(lines: readonly RedemptionLine[]): void {
  const checks: StockCheckItem[] = lines.map((line) => ({
    productId: line.productId,
    name: line.product.name,
    requestedQuantity: line.quantity,
    availableStock: line.product.stock,
  }))
  assertWithinStock(checks)
}

// ---------------------------------------------------------------------------
// Drizzle-backed default store
// ---------------------------------------------------------------------------

import { and, asc, eq, inArray, sql } from 'drizzle-orm'

import { db as defaultDb, type Database } from '../db/client'
import {
  cartItems,
  carts,
  cdks,
  orderItems,
  orders,
  pointsAccounts,
  pointsLedger,
  products,
} from '../db/schema'

/** Drizzle 事务回调所接收的事务句柄类型（从 `Database['transaction']` 推导）。 */
type DrizzleTx = Parameters<Parameters<Database['transaction']>[0]>[0]

/** 基于单个 Drizzle 事务的 {@link RedemptionTx} 实现（行锁 + 版本条件更新）。 */
export class DrizzleRedemptionTx implements RedemptionTx {
  constructor(private readonly tx: DrizzleTx) {}

  async lockPointsAccount(userId: string): Promise<LockedAccount | null> {
    const rows = await this.tx
      .select({
        userId: pointsAccounts.userId,
        balance: pointsAccounts.balance,
        version: pointsAccounts.version,
      })
      .from(pointsAccounts)
      .where(eq(pointsAccounts.userId, userId))
      .for('update')
      .limit(1)
    return rows[0] ?? null
  }

  async lockProductsAscending(productIds: readonly string[]): Promise<LockedProduct[]> {
    if (productIds.length === 0) return []
    const rows = await this.tx
      .select({
        id: products.id,
        name: products.name,
        type: products.type,
        pointsCost: products.pointsCost,
        stock: products.stock,
        version: products.version,
      })
      .from(products)
      .where(inArray(products.id, [...productIds]))
      // 升序锁定，保证并发事务以一致顺序获取行锁，避免死锁（需求 7.10）。
      .orderBy(asc(products.id))
      .for('update')
    return rows.map((r) => ({ ...r, type: r.type as ProductType }))
  }

  async decrementProductStock(
    productId: string,
    quantity: number,
    expectedVersion: number,
  ): Promise<number> {
    // 版本条件相对扣减；返回受影响行数（0 => 版本不匹配 => 并发冲突）。
    const updated = await this.tx
      .update(products)
      .set({
        stock: sql`${products.stock} - ${quantity}`,
        version: sql`${products.version} + 1`,
      })
      .where(and(eq(products.id, productId), eq(products.version, expectedVersion)))
      .returning({ id: products.id })
    return updated.length
  }

  async decrementBalance(userId: string, amount: number): Promise<void> {
    await this.tx
      .update(pointsAccounts)
      .set({
        balance: sql`${pointsAccounts.balance} - ${amount}`,
        version: sql`${pointsAccounts.version} + 1`,
      })
      .where(eq(pointsAccounts.userId, userId))
  }

  async insertOrder(order: NewOrderInput): Promise<string> {
    const inserted = await this.tx
      .insert(orders)
      .values({
        userId: order.userId,
        type: order.type,
        pointsSpent: order.pointsSpent,
        shippingAddress: order.shippingAddress ?? null,
      })
      .returning({ id: orders.id })
    return inserted[0].id
  }

  async insertOrderItems(orderId: string, items: readonly NewOrderItemInput[]): Promise<void> {
    if (items.length === 0) return
    await this.tx.insert(orderItems).values(
      items.map((it) => ({
        orderId,
        productId: it.productId,
        productName: it.productName,
        quantity: it.quantity,
        unitPoints: it.unitPoints,
      })),
    )
  }

  async consumeCdks(productId: string, quantity: number, orderId: string): Promise<void> {
    if (quantity <= 0) return
    // 锁定并选取最早的 `quantity` 个可用 CDK（稳定顺序），每虚拟单位消耗 1 个（需求 9.2）。
    const available = await this.tx
      .select({ id: cdks.id })
      .from(cdks)
      .where(and(eq(cdks.productId, productId), eq(cdks.status, 'available')))
      .orderBy(asc(cdks.id))
      .limit(quantity)
      .for('update')
    if (available.length < quantity) {
      // 一致性兜底：正常流程已在锁定/库存校验阶段拦截（虚拟库存=可用 CDK 数，需求 5.1）。
      throw new HttpError(ErrorCode.InsufficientStock, `虚拟商品可用兑换码不足：${productId}`)
    }
    await this.tx
      .update(cdks)
      .set({ status: 'consumed', orderId })
      .where(
        inArray(
          cdks.id,
          available.map((r) => r.id),
        ),
      )
  }

  async insertPointsLedger(entry: NewPointsLedgerInput): Promise<void> {
    await this.tx.insert(pointsLedger).values({
      userId: entry.userId,
      delta: entry.delta,
      reason: entry.reason,
      note: entry.note ?? null,
      balanceAfter: entry.balanceAfter,
    })
  }

  async removeCartItems(userId: string, productIds: readonly string[]): Promise<void> {
    if (productIds.length === 0) return
    const cartRows = await this.tx
      .select({ id: carts.id })
      .from(carts)
      .where(eq(carts.userId, userId))
      .limit(1)
    const cartId = cartRows[0]?.id
    if (!cartId) return // 无购物车（如立即兑换）——幂等无操作（需求 7.5）。
    await this.tx
      .delete(cartItems)
      .where(and(eq(cartItems.cartId, cartId), inArray(cartItems.productId, [...productIds])))
  }

  get handle(): unknown {
    return this.tx
  }
}

/** 基于 Drizzle `db.transaction` 的默认 {@link RedemptionStore} 实现。 */
export class DrizzleRedemptionStore implements RedemptionStore {
  constructor(private readonly db: Database = defaultDb) {}

  async transaction<T>(fn: (tx: RedemptionTx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => fn(new DrizzleRedemptionTx(tx)))
  }
}
