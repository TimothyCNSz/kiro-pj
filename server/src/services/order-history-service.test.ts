import { describe, it, expect, beforeEach } from 'vitest'

import {
  OrderHistoryService,
  toLimitOffset,
  type OrderHistoryRepository,
  type OrderRecord,
} from './order-history-service'
import { OrderStatus, OrderType } from '../lib/domain'

// ---------------------------------------------------------------------------
// In-memory fake repository (no real DB).
// ---------------------------------------------------------------------------

class FakeOrderHistoryRepository implements OrderHistoryRepository {
  /** orderId -> record. */
  readonly ordersById = new Map<string, OrderRecord>()
  /** orderId -> associated CDK codes. */
  readonly cdksByOrder = new Map<string, string[]>()
  /** userId -> balance. */
  readonly balances = new Map<string, number>()

  seedOrder(record: OrderRecord): void {
    this.ordersById.set(record.id, record)
  }

  seedCdks(orderId: string, codes: string[]): void {
    this.cdksByOrder.set(orderId, codes)
  }

  seedBalance(userId: string, balance: number): void {
    this.balances.set(userId, balance)
  }

  async listOrders(
    userId: string,
    range: { limit: number; offset: number },
  ): Promise<{ records: OrderRecord[]; total: number }> {
    const all = [...this.ordersById.values()]
      .filter((o) => o.userId === userId)
      // Newest-first by createdAt, tie-break by id desc (mirrors Drizzle repo).
      .sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
      )
    const records = all.slice(range.offset, range.offset + range.limit)
    return { records, total: all.length }
  }

  async getOrder(userId: string, orderId: string): Promise<OrderRecord | null> {
    const record = this.ordersById.get(orderId)
    // Owner scoping: another user's order is indistinguishable from missing.
    if (!record || record.userId !== userId) return null
    return record
  }

  async listOrderCdkCodes(orderId: string): Promise<string[]> {
    return this.cdksByOrder.get(orderId) ?? []
  }

  async getBalance(userId: string): Promise<number> {
    return this.balances.get(userId) ?? 0
  }
}

const USER = 'user-1'

function line(productName: string, quantity = 1, unitPoints = 100) {
  return { productId: `p-${productName}`, productName, quantity, unitPoints }
}

function physicalOrder(id: string, createdAt: Date, overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id,
    userId: USER,
    type: OrderType.Physical,
    status: OrderStatus.PendingShipment,
    pointsSpent: 100,
    shippingAddress: { recipient: 'Bob', phone: '123', detail: 'Street 1' },
    trackingNo: null,
    createdAt,
    items: [line('Mug')],
    ...overrides,
  }
}

function virtualOrder(id: string, createdAt: Date, overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id,
    userId: USER,
    type: OrderType.Virtual,
    status: OrderStatus.PendingShipment,
    pointsSpent: 80,
    shippingAddress: null,
    trackingNo: null,
    createdAt,
    items: [line('GiftCard', 1, 80)],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// toLimitOffset (pure pagination normalization)
// ---------------------------------------------------------------------------

describe('toLimitOffset', () => {
  it('defaults to page 1 / pageSize 20 for missing or invalid values', () => {
    expect(toLimitOffset({ page: 0, pageSize: -5 })).toEqual({ limit: 20, offset: 0 })
    expect(toLimitOffset({ page: Number.NaN, pageSize: Number.NaN })).toEqual({
      limit: 20,
      offset: 0,
    })
  })

  it('computes offset from page and clamps pageSize to the max', () => {
    expect(toLimitOffset({ page: 3, pageSize: 15 })).toEqual({ limit: 15, offset: 30 })
    expect(toLimitOffset({ page: 1, pageSize: 9999 })).toEqual({ limit: 100, offset: 0 })
  })
})

// ---------------------------------------------------------------------------
// listOrders (需求 11.1, 11.2, 11.3, 11.4)
// ---------------------------------------------------------------------------

describe('OrderHistoryService.listOrders', () => {
  let repo: FakeOrderHistoryRepository
  let service: OrderHistoryService
  beforeEach(() => {
    repo = new FakeOrderHistoryRepository()
    service = new OrderHistoryService({ repository: repo })
  })

  it('returns an empty list for a user with no orders (需求 11.4)', async () => {
    const page = await service.listOrders(USER, { page: 1, pageSize: 20 })
    expect(page).toEqual({ list: [], total: 0, page: 1, pageSize: 20 })
  })

  it('each record carries product name, points spent, redeem time and status (需求 11.1)', async () => {
    repo.seedOrder(physicalOrder('o1', new Date('2024-01-01T00:00:00Z')))
    const page = await service.listOrders(USER, { page: 1, pageSize: 20 })
    expect(page.list).toHaveLength(1)
    const item = page.list[0]
    expect(item.items[0].productName).toBe('Mug')
    expect(item.pointsSpent).toBe(100)
    expect(item.createdAt).toEqual(new Date('2024-01-01T00:00:00Z'))
    expect(item.status).toBe(OrderStatus.PendingShipment)
  })

  it('sorts history newest-first by redeem time (需求 11.2)', async () => {
    repo.seedOrder(physicalOrder('old', new Date('2024-01-01T00:00:00Z')))
    repo.seedOrder(physicalOrder('new', new Date('2024-03-01T00:00:00Z')))
    repo.seedOrder(physicalOrder('mid', new Date('2024-02-01T00:00:00Z')))
    const page = await service.listOrders(USER, { page: 1, pageSize: 20 })
    expect(page.list.map((o) => o.id)).toEqual(['new', 'mid', 'old'])
  })

  it('paginates so pages concatenate to the full set with no gaps/duplicates (需求 11.3; Property 26)', async () => {
    // 5 orders, newest-first ids o5..o1.
    for (let i = 1; i <= 5; i++) {
      repo.seedOrder(physicalOrder(`o${i}`, new Date(`2024-01-0${i}T00:00:00Z`)))
    }
    const p1 = await service.listOrders(USER, { page: 1, pageSize: 2 })
    const p2 = await service.listOrders(USER, { page: 2, pageSize: 2 })
    const p3 = await service.listOrders(USER, { page: 3, pageSize: 2 })

    expect(p1.total).toBe(5)
    expect(p1.list.map((o) => o.id)).toEqual(['o5', 'o4'])
    expect(p2.list.map((o) => o.id)).toEqual(['o3', 'o2'])
    expect(p3.list.map((o) => o.id)).toEqual(['o1'])

    const stitched = [...p1.list, ...p2.list, ...p3.list].map((o) => o.id)
    expect(stitched).toEqual(['o5', 'o4', 'o3', 'o2', 'o1'])
    // No page exceeds the page capacity.
    for (const page of [p1, p2, p3]) {
      expect(page.list.length).toBeLessThanOrEqual(2)
      expect(page.pageSize).toBe(2)
    }
  })

  it('only returns the requesting user\'s orders', async () => {
    repo.seedOrder(physicalOrder('mine', new Date('2024-01-01T00:00:00Z')))
    repo.seedOrder(physicalOrder('theirs', new Date('2024-02-01T00:00:00Z'), { userId: 'other' }))
    const page = await service.listOrders(USER, { page: 1, pageSize: 20 })
    expect(page.list.map((o) => o.id)).toEqual(['mine'])
    expect(page.total).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// getOrder (需求 8.3, 9.3, 9.4 + owner scoping)
// ---------------------------------------------------------------------------

describe('OrderHistoryService.getOrder', () => {
  let repo: FakeOrderHistoryRepository
  let service: OrderHistoryService
  beforeEach(() => {
    repo = new FakeOrderHistoryRepository()
    service = new OrderHistoryService({ repository: repo })
  })

  it('returns null for a non-existent order', async () => {
    expect(await service.getOrder(USER, 'ghost')).toBeNull()
  })

  it('returns null when the order belongs to another user (owner scoping)', async () => {
    repo.seedOrder(physicalOrder('theirs', new Date(), { userId: 'other' }))
    expect(await service.getOrder(USER, 'theirs')).toBeNull()
  })

  it('physical order exposes shipping address and tracking number once shipped (需求 8.3)', async () => {
    repo.seedOrder(
      physicalOrder('phys', new Date(), {
        status: OrderStatus.Shipped,
        trackingNo: 'SF123456',
      }),
    )
    const detail = await service.getOrder(USER, 'phys')
    expect(detail).not.toBeNull()
    expect(detail!.status).toBe(OrderStatus.Shipped)
    expect(detail!.trackingNo).toBe('SF123456')
    expect(detail!.shippingAddress).toMatchObject({ recipient: 'Bob' })
    expect(detail!.cdks).toEqual([])
  })

  it('physical order pending shipment has no tracking number (需求 8.4)', async () => {
    repo.seedOrder(physicalOrder('phys', new Date()))
    const detail = await service.getOrder(USER, 'phys')
    expect(detail!.status).toBe(OrderStatus.PendingShipment)
    expect(detail!.trackingNo).toBeNull()
  })

  it('virtual order hides CDKs before virtual shipment (需求 9.3)', async () => {
    repo.seedOrder(virtualOrder('virt', new Date()))
    repo.seedCdks('virt', ['CODE-1'])
    const detail = await service.getOrder(USER, 'virt')
    expect(detail!.status).toBe(OrderStatus.PendingShipment)
    expect(detail!.cdks).toEqual([])
    expect(detail!.shippingAddress).toBeNull()
    expect(detail!.trackingNo).toBeNull()
  })

  it('virtual order reveals associated CDKs once shipped (需求 9.4)', async () => {
    repo.seedOrder(virtualOrder('virt', new Date(), { status: OrderStatus.Shipped }))
    repo.seedCdks('virt', ['CODE-1', 'CODE-2'])
    const detail = await service.getOrder(USER, 'virt')
    expect(detail!.status).toBe(OrderStatus.Shipped)
    expect(detail!.cdks).toEqual(['CODE-1', 'CODE-2'])
  })
})

// ---------------------------------------------------------------------------
// getBalance (需求 10.1, 10.2, 10.3)
// ---------------------------------------------------------------------------

describe('OrderHistoryService.getBalance', () => {
  let repo: FakeOrderHistoryRepository
  let service: OrderHistoryService
  beforeEach(() => {
    repo = new FakeOrderHistoryRepository()
    service = new OrderHistoryService({ repository: repo })
  })

  it('returns the current available balance (需求 10.1)', async () => {
    repo.seedBalance(USER, 1250)
    expect(await service.getBalance(USER)).toBe(1250)
  })

  it('returns 0 when the user has no points account', async () => {
    expect(await service.getBalance(USER)).toBe(0)
  })

  it('never returns a negative balance (需求 10.3)', async () => {
    // Defensive clamp even if an upstream value were negative.
    repo.seedBalance(USER, -5)
    expect(await service.getBalance(USER)).toBe(0)
  })
})
