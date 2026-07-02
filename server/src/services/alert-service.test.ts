import { describe, it, expect } from 'vitest'

import {
  AlertService,
  type AlertGateway,
  type DbOrTx,
  type LowStockAlertView,
} from './alert-service'

// ---------------------------------------------------------------------------
// Fake gateway (in-memory, no real DB)
//
// Models the database dedup semantics (LowStockAlert.productId UNIQUE +
// onConflictDoNothing): inserting an alert for a productId that already has one
// is silently ignored, so at most ONE alert exists per product (需求 15.1).
// ---------------------------------------------------------------------------

class FakeAlertGateway implements AlertGateway {
  /** productId -> alert (at most one per product, mirroring the UNIQUE index). */
  readonly alerts = new Map<string, LowStockAlertView>()
  /** productId -> display name (optional). */
  readonly productNames: Record<string, string>
  /** Records the handle passed to each write, to assert tx pass-through. */
  readonly receivedHandles: Array<DbOrTx | undefined> = []
  private seq = 0

  constructor(productNames: Record<string, string> = {}) {
    this.productNames = productNames
  }

  async insertAlertIgnoringDuplicate(productId: string, handle?: DbOrTx): Promise<void> {
    this.receivedHandles.push(handle)
    // Dedup: a second trigger for the same product is a no-op (onConflictDoNothing).
    if (this.alerts.has(productId)) return
    this.seq += 1
    this.alerts.set(productId, {
      id: `alert-${this.seq}`,
      productId,
      productName: this.productNames[productId] ?? productId,
      triggeredAt: new Date(this.seq),
    })
  }

  async listActiveAlerts(): Promise<LowStockAlertView[]> {
    return [...this.alerts.values()]
  }
}

// ---------------------------------------------------------------------------
// AlertService.triggerLowStock — dedup (需求 5.3, 15.1)
// ---------------------------------------------------------------------------

describe('AlertService.triggerLowStock', () => {
  it('records a single alert for a product (需求 5.3)', async () => {
    const gateway = new FakeAlertGateway({ p1: '实物商品 A' })
    const service = new AlertService({ gateway })

    await service.triggerLowStock('p1')

    const alerts = await service.listLowStock()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({ productId: 'p1', productName: '实物商品 A' })
  })

  it('deduplicates: triggering twice for the same product yields a single alert (需求 15.1)', async () => {
    const gateway = new FakeAlertGateway()
    const service = new AlertService({ gateway })

    await service.triggerLowStock('p1')
    await service.triggerLowStock('p1')
    await service.triggerLowStock('p1')

    const alerts = await service.listLowStock()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.productId).toBe('p1')
  })

  it('keeps distinct alerts for different products', async () => {
    const gateway = new FakeAlertGateway()
    const service = new AlertService({ gateway })

    await service.triggerLowStock('p1')
    await service.triggerLowStock('p2')
    await service.triggerLowStock('p1') // duplicate of p1 — ignored

    const ids = (await service.listLowStock()).map((a) => a.productId).sort()
    expect(ids).toEqual(['p1', 'p2'])
  })

  it('forwards the optional transaction handle to the gateway (任务 8.9 事务参与)', async () => {
    const gateway = new FakeAlertGateway()
    const service = new AlertService({ gateway })

    // A stand-in tx handle; the service must pass it straight through so the
    // write can participate in the redemption transaction.
    const fakeTx = { marker: 'tx' } as unknown as DbOrTx
    await service.triggerLowStock('p1', fakeTx)

    expect(gateway.receivedHandles).toEqual([fakeTx])
  })

  it('still deduplicates when called within a transaction handle', async () => {
    const gateway = new FakeAlertGateway()
    const service = new AlertService({ gateway })
    const fakeTx = {} as unknown as DbOrTx

    await service.triggerLowStock('p1', fakeTx)
    await service.triggerLowStock('p1', fakeTx)

    expect(await service.listLowStock()).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// AlertService.listLowStock — 后台展示 (需求 15.2)
// ---------------------------------------------------------------------------

describe('AlertService.listLowStock', () => {
  it('returns an empty list when there are no alerts', async () => {
    const service = new AlertService({ gateway: new FakeAlertGateway() })
    expect(await service.listLowStock()).toEqual([])
  })

  it('lists current low-stock alerts for the admin dashboard (需求 15.2)', async () => {
    const gateway = new FakeAlertGateway({ p1: '商品一', p2: '商品二' })
    const service = new AlertService({ gateway })

    await service.triggerLowStock('p1')
    await service.triggerLowStock('p2')

    const alerts = await service.listLowStock()
    expect(alerts).toHaveLength(2)
    expect(alerts.map((a) => a.productName).sort()).toEqual(['商品一', '商品二'])
  })
})
