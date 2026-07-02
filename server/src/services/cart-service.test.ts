import { describe, it, expect, beforeEach } from 'vitest'

import {
  CartService,
  computeCartView,
  type CartLineRow,
  type CartRepository,
} from './cart-service'
import { HttpError } from '../middleware/http-error'
import { ErrorCode } from '../lib/errors'
import { ProductType } from '../lib/domain'
import type { StockProductView, StockResolver } from './product-stock'

// ---------------------------------------------------------------------------
// In-memory fake repository (no real DB) — persists carts + lines by userId.
// ---------------------------------------------------------------------------

interface FakeProduct {
  id: string
  name: string
  pointsCost: number
  /** 商品类型（默认实物）。 */
  type: ProductType
  /** 可兑换库存（默认充足，便于沿用既有购物车用例）。 */
  stock: number
}

/**
 * 内存库存解析器替身：直接返回 fake 商品的 stock 作为可兑换库存，
 * 避免触达真实 CDK 计数 / 数据库（虚拟商品 CDK 路径由 product-stock.test 覆盖）。
 */
class FakeStockResolver implements StockResolver {
  async resolve(product: StockProductView): Promise<number> {
    return product.stock
  }
}

class FakeCartRepository implements CartRepository {
  /** productId -> product (catalog). */
  readonly products = new Map<string, FakeProduct>()
  /** userId -> cartId. */
  private readonly cartsByUser = new Map<string, string>()
  /** cartId -> (productId -> quantity). */
  private readonly lines = new Map<string, Map<string, number>>()
  private cartSeq = 0

  seedProduct(p: {
    id: string
    name: string
    pointsCost: number
    type?: ProductType
    stock?: number
  }): void {
    this.products.set(p.id, {
      id: p.id,
      name: p.name,
      pointsCost: p.pointsCost,
      type: p.type ?? ProductType.Physical,
      stock: p.stock ?? 1000,
    })
  }

  async ensureCart(userId: string): Promise<string> {
    let cartId = this.cartsByUser.get(userId)
    if (!cartId) {
      cartId = `cart-${++this.cartSeq}`
      this.cartsByUser.set(userId, cartId)
      this.lines.set(cartId, new Map())
    }
    return cartId
  }

  async listLines(cartId: string): Promise<CartLineRow[]> {
    const map = this.lines.get(cartId) ?? new Map<string, number>()
    const rows: CartLineRow[] = []
    for (const [productId, quantity] of map) {
      const product = this.products.get(productId)
      if (!product) continue
      rows.push({ productId, name: product.name, unitPoints: product.pointsCost, quantity })
    }
    // Stable ordering by name then productId, mirroring the Drizzle repo.
    return rows.sort(
      (a, b) => a.name.localeCompare(b.name) || a.productId.localeCompare(b.productId),
    )
  }

  async findLineQuantity(cartId: string, productId: string): Promise<number | null> {
    return this.lines.get(cartId)?.get(productId) ?? null
  }

  async addLine(cartId: string, productId: string, quantity: number): Promise<void> {
    this.lines.get(cartId)!.set(productId, quantity)
  }

  async setLineQuantity(cartId: string, productId: string, quantity: number): Promise<void> {
    this.lines.get(cartId)!.set(productId, quantity)
  }

  async removeLine(cartId: string, productId: string): Promise<void> {
    this.lines.get(cartId)?.delete(productId)
  }

  async findProductUnitPoints(productId: string): Promise<number | null> {
    return this.products.get(productId)?.pointsCost ?? null
  }

  async findProductStockView(productId: string): Promise<StockProductView | null> {
    const p = this.products.get(productId)
    if (!p) return null
    return { id: p.id, type: p.type, stock: p.stock }
  }
}

function buildService(): { service: CartService; repo: FakeCartRepository } {
  const repo = new FakeCartRepository()
  repo.seedProduct({ id: 'p1', name: 'Alpha', pointsCost: 100 })
  repo.seedProduct({ id: 'p2', name: 'Beta', pointsCost: 250 })
  const service = new CartService({ repository: repo, stockResolver: new FakeStockResolver() })
  return { service, repo }
}

const USER = 'user-1'

// ---------------------------------------------------------------------------
// computeCartView (pure core — Property 12 invariant)
// ---------------------------------------------------------------------------

describe('computeCartView', () => {
  it('computes each subtotal = unitPoints * quantity and total = Σ subtotal (需求 6.5)', () => {
    const view = computeCartView([
      { productId: 'p1', name: 'Alpha', unitPoints: 100, quantity: 2 },
      { productId: 'p2', name: 'Beta', unitPoints: 250, quantity: 3 },
    ])
    expect(view.items.map((i) => i.subtotal)).toEqual([200, 750])
    expect(view.totalPoints).toBe(950)
  })

  it('returns empty cart with zero total for no lines', () => {
    expect(computeCartView([])).toEqual({ items: [], totalPoints: 0 })
  })
})

// ---------------------------------------------------------------------------
// CartService
// ---------------------------------------------------------------------------

describe('CartService', () => {
  let service: CartService
  let repo: FakeCartRepository
  beforeEach(() => {
    ({ service, repo } = buildService())
  })

  it('starts with an empty persisted cart (需求 6.6)', async () => {
    const cart = await service.getCart(USER)
    expect(cart).toEqual({ items: [], totalPoints: 0 })
  })

  it('adds an item and recomputes subtotal + total (需求 6.1, 6.5)', async () => {
    const cart = await service.addItem(USER, 'p1', 2)
    expect(cart.items).toEqual([
      { productId: 'p1', name: 'Alpha', unitPoints: 100, quantity: 2, subtotal: 200 },
    ])
    expect(cart.totalPoints).toBe(200)
  })

  it('accumulates quantity when the same product is added again (需求 6.1)', async () => {
    await service.addItem(USER, 'p1', 2)
    const cart = await service.addItem(USER, 'p1', 3)
    expect(cart.items).toHaveLength(1)
    expect(cart.items[0].quantity).toBe(5)
    expect(cart.totalPoints).toBe(500)
  })

  it('adds multiple products and totals across lines (需求 6.5)', async () => {
    await service.addItem(USER, 'p1', 1)
    const cart = await service.addItem(USER, 'p2', 2)
    expect(cart.totalPoints).toBe(100 + 500)
    expect(cart.items.map((i) => i.productId)).toEqual(['p1', 'p2'])
  })

  it('updates quantity and recomputes total in real time (需求 6.2)', async () => {
    await service.addItem(USER, 'p1', 2)
    const cart = await service.updateItem(USER, 'p1', 5)
    expect(cart.items[0].quantity).toBe(5)
    expect(cart.items[0].subtotal).toBe(500)
    expect(cart.totalPoints).toBe(500)
  })

  it('removes an item and recomputes total (需求 6.4)', async () => {
    await service.addItem(USER, 'p1', 2)
    await service.addItem(USER, 'p2', 1)
    const cart = await service.removeItem(USER, 'p1')
    expect(cart.items.map((i) => i.productId)).toEqual(['p2'])
    expect(cart.totalPoints).toBe(250)
  })

  it('remove is idempotent for a product not in the cart (需求 6.4)', async () => {
    const cart = await service.removeItem(USER, 'p1')
    expect(cart).toEqual({ items: [], totalPoints: 0 })
  })

  it('persists across sessions/devices: same userId reads back identical cart (需求 6.6)', async () => {
    await service.addItem(USER, 'p2', 2)
    await service.addItem(USER, 'p1', 1)
    const first = await service.getCart(USER)
    // A fresh service instance sharing the same repository (= server-side store).
    const second = await new CartService({ repository: repo }).getCart(USER)
    expect(second).toEqual(first)
  })

  it('rejects adding a non-existent product with INVALID_PRODUCT_FIELD', async () => {
    await expect(service.addItem(USER, 'ghost', 1)).rejects.toMatchObject({
      errorCode: ErrorCode.InvalidProductField,
    })
  })

  it('rejects updating a product not in the cart with INVALID_PRODUCT_FIELD', async () => {
    await expect(service.updateItem(USER, 'p1', 2)).rejects.toBeInstanceOf(HttpError)
  })

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects invalid add quantity %p with VALIDATION',
    async (qty) => {
      await expect(service.addItem(USER, 'p1', qty as number)).rejects.toMatchObject({
        errorCode: ErrorCode.Validation,
      })
    },
  )

  it('rejects invalid update quantity with VALIDATION', async () => {
    await service.addItem(USER, 'p1', 2)
    await expect(service.updateItem(USER, 'p1', 0)).rejects.toMatchObject({
      errorCode: ErrorCode.Validation,
    })
  })
})

// ---------------------------------------------------------------------------
// Stock enforcement (任务 7.3 — 需求 5.2, 6.3)
// ---------------------------------------------------------------------------

describe('CartService stock enforcement', () => {
  const USER2 = 'user-2'

  function buildWithStock(): { service: CartService; repo: FakeCartRepository } {
    const repo = new FakeCartRepository()
    repo.seedProduct({ id: 'sold-out', name: 'SoldOut', pointsCost: 50, stock: 0 })
    repo.seedProduct({ id: 'limited', name: 'Limited', pointsCost: 50, stock: 3 })
    repo.seedProduct({
      id: 'v-out',
      name: 'VirtualOut',
      pointsCost: 80,
      type: ProductType.Virtual,
      stock: 0,
    })
    const service = new CartService({ repository: repo, stockResolver: new FakeStockResolver() })
    return { service, repo }
  }

  it('rejects adding a zero-stock (sold out) product with INSUFFICIENT_STOCK (需求 5.2)', async () => {
    const { service } = buildWithStock()
    await expect(service.addItem(USER2, 'sold-out', 1)).rejects.toMatchObject({
      errorCode: ErrorCode.InsufficientStock,
    })
  })

  it('rejects adding a sold-out virtual product (zero available CDKs) (需求 5.2)', async () => {
    const { service } = buildWithStock()
    await expect(service.addItem(USER2, 'v-out', 1)).rejects.toMatchObject({
      errorCode: ErrorCode.InsufficientStock,
    })
  })

  it('rejects adding a quantity above available stock (需求 6.3)', async () => {
    const { service } = buildWithStock()
    await expect(service.addItem(USER2, 'limited', 4)).rejects.toMatchObject({
      errorCode: ErrorCode.InsufficientStock,
    })
  })

  it('allows adding up to available stock', async () => {
    const { service } = buildWithStock()
    const cart = await service.addItem(USER2, 'limited', 3)
    expect(cart.items[0].quantity).toBe(3)
  })

  it('rejects when accumulated quantity would exceed stock (需求 6.3)', async () => {
    const { service } = buildWithStock()
    await service.addItem(USER2, 'limited', 2)
    // 2 already in cart; adding 2 more (=4) exceeds stock of 3.
    await expect(service.addItem(USER2, 'limited', 2)).rejects.toMatchObject({
      errorCode: ErrorCode.InsufficientStock,
    })
  })

  it('rejects updating quantity above available stock with INSUFFICIENT_STOCK (需求 6.3)', async () => {
    const { service } = buildWithStock()
    await service.addItem(USER2, 'limited', 1)
    await expect(service.updateItem(USER2, 'limited', 5)).rejects.toMatchObject({
      errorCode: ErrorCode.InsufficientStock,
    })
  })

  it('allows updating quantity within available stock', async () => {
    const { service } = buildWithStock()
    await service.addItem(USER2, 'limited', 1)
    const cart = await service.updateItem(USER2, 'limited', 3)
    expect(cart.items[0].quantity).toBe(3)
  })

  it('validateAgainstStock passes when every line is within stock (需求 6.3)', async () => {
    const { service } = buildWithStock()
    await service.addItem(USER2, 'limited', 2)
    const cart = await service.validateAgainstStock(USER2)
    expect(cart.totalPoints).toBe(100)
  })

  it('validateAgainstStock rejects when a line exceeds stock after stock shrinks (需求 6.3)', async () => {
    const { service, repo } = buildWithStock()
    await service.addItem(USER2, 'limited', 3)
    // Simulate stock dropping below the cart quantity (e.g. concurrent redemption).
    repo.seedProduct({ id: 'limited', name: 'Limited', pointsCost: 50, stock: 1 })
    await expect(service.validateAgainstStock(USER2)).rejects.toMatchObject({
      errorCode: ErrorCode.InsufficientStock,
    })
  })

  it('validateAgainstStock rejects when a line became sold out (需求 5.2, 6.3)', async () => {
    const { service, repo } = buildWithStock()
    await service.addItem(USER2, 'limited', 1)
    repo.seedProduct({ id: 'limited', name: 'Limited', pointsCost: 50, stock: 0 })
    await expect(service.validateAgainstStock(USER2)).rejects.toMatchObject({
      errorCode: ErrorCode.InsufficientStock,
    })
  })
})
