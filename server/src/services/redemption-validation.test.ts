import { describe, it, expect } from 'vitest'

import {
  buildRedemptionPreValidate,
  validateRedemption,
  assertAddressForPhysical,
  assertLinesWithinStock,
  containsPhysicalLine,
  isValidAddress,
  toStockCheckItems,
} from './redemption-validation'
import { HttpError } from '../middleware/http-error'
import { ErrorCode } from '../lib/errors'
import { ProductType } from '../lib/domain'
import type {
  Address,
  LockedAccount,
  LockedProduct,
  RedemptionContext,
  RedemptionLine,
} from './redemption-service'

// ---------------------------------------------------------------------------
// Fixtures — deeply frozen so any accidental mutation by the (pure) validators
// throws in strict mode, proving side-effect freedom (需求 5.4/5.5/6.3/7.3).
// ---------------------------------------------------------------------------

function makeProduct(overrides: Partial<LockedProduct> = {}): LockedProduct {
  return Object.freeze({
    id: overrides.id ?? 'p1',
    name: overrides.name ?? '商品',
    type: overrides.type ?? ProductType.Virtual,
    pointsCost: overrides.pointsCost ?? 10,
    stock: overrides.stock ?? 5,
    version: overrides.version ?? 0,
  })
}

function makeLine(overrides: Partial<LockedProduct> & { quantity?: number } = {}): RedemptionLine {
  const product = makeProduct(overrides)
  const quantity = overrides.quantity ?? 1
  return Object.freeze({
    productId: product.id,
    quantity,
    product,
    cost: product.pointsCost * quantity,
  })
}

function makeContext(over: {
  balance?: number
  lines?: RedemptionLine[]
  address?: Address
} = {}): RedemptionContext {
  const lines = over.lines ?? [makeLine()]
  const totalCost = lines.reduce((s, l) => s + l.cost, 0)
  const account: LockedAccount = Object.freeze({
    userId: 'u1',
    balance: over.balance ?? 1000,
    version: 0,
  })
  const ctx = {
    userId: 'u1',
    account,
    lines: Object.freeze([...lines]) as unknown as RedemptionLine[],
    totalCost,
    address: over.address ? Object.freeze({ ...over.address }) : undefined,
  }
  return Object.freeze(ctx) as RedemptionContext
}

const VALID_ADDRESS: Address = {
  recipient: '张三',
  phone: '13800000000',
  detail: '某市某区某街道 1 号',
}

/** Assert the thrown error is an HttpError carrying the expected code. */
function expectRejection(fn: () => void, code: ErrorCode): void {
  expect(fn).toThrowError(HttpError)
  try {
    fn()
    throw new Error('expected function to throw')
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).errorCode).toBe(code)
  }
}

// ---------------------------------------------------------------------------
// Rejection reasons
// ---------------------------------------------------------------------------

describe('validateRedemption — rejection reasons', () => {
  it('rejects with INSUFFICIENT_POINTS when balance < totalCost (需求 5.4)', () => {
    const ctx = makeContext({
      balance: 5,
      lines: [makeLine({ pointsCost: 10, quantity: 1, stock: 5 })],
    })
    expectRejection(() => validateRedemption(ctx), ErrorCode.InsufficientPoints)
  })

  it('rejects with INSUFFICIENT_STOCK when any quantity > stock (需求 5.5, 6.3)', () => {
    const ctx = makeContext({
      balance: 10_000,
      lines: [makeLine({ id: 'p1', pointsCost: 1, quantity: 6, stock: 5 })],
    })
    expectRejection(() => validateRedemption(ctx), ErrorCode.InsufficientStock)
  })

  it('rejects with INSUFFICIENT_STOCK when a product is sold out (stock = 0)', () => {
    const ctx = makeContext({
      balance: 10_000,
      lines: [makeLine({ id: 'p1', pointsCost: 1, quantity: 1, stock: 0 })],
    })
    expectRejection(() => validateRedemption(ctx), ErrorCode.InsufficientStock)
  })

  it('rejects with ADDRESS_REQUIRED when physical item present but no address (需求 7.3)', () => {
    const ctx = makeContext({
      balance: 10_000,
      lines: [makeLine({ id: 'p1', type: ProductType.Physical, quantity: 1, stock: 5 })],
    })
    expectRejection(() => validateRedemption(ctx), ErrorCode.AddressRequired)
  })

  it('rejects with ADDRESS_REQUIRED when physical item present but address incomplete', () => {
    const ctx = makeContext({
      balance: 10_000,
      lines: [makeLine({ id: 'p1', type: ProductType.Physical, quantity: 1, stock: 5 })],
      address: { recipient: '张三', phone: '   ', detail: '' },
    })
    expectRejection(() => validateRedemption(ctx), ErrorCode.AddressRequired)
  })
})

// ---------------------------------------------------------------------------
// Passing cases
// ---------------------------------------------------------------------------

describe('validateRedemption — passing cases', () => {
  it('passes for a pure virtual redemption without address (需求 9.1)', () => {
    const ctx = makeContext({
      balance: 100,
      lines: [makeLine({ id: 'p1', type: ProductType.Virtual, pointsCost: 10, quantity: 2, stock: 5 })],
    })
    expect(() => validateRedemption(ctx)).not.toThrow()
  })

  it('passes for a physical redemption with a valid address', () => {
    const ctx = makeContext({
      balance: 100,
      lines: [makeLine({ id: 'p1', type: ProductType.Physical, pointsCost: 10, quantity: 1, stock: 5 })],
      address: VALID_ADDRESS,
    })
    expect(() => validateRedemption(ctx)).not.toThrow()
  })

  it('passes when balance exactly equals totalCost and quantity equals stock (boundaries)', () => {
    const ctx = makeContext({
      balance: 30,
      lines: [makeLine({ id: 'p1', type: ProductType.Virtual, pointsCost: 10, quantity: 3, stock: 3 })],
    })
    expect(ctx.totalCost).toBe(30)
    expect(() => validateRedemption(ctx)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// buildRedemptionPreValidate — hook factory
// ---------------------------------------------------------------------------

describe('buildRedemptionPreValidate', () => {
  it('returns a preValidate hook that rejects invalid and accepts valid contexts', () => {
    const preValidate = buildRedemptionPreValidate()
    const bad = makeContext({ balance: 0, lines: [makeLine({ pointsCost: 10, quantity: 1, stock: 5 })] })
    const good = makeContext({ balance: 1000, lines: [makeLine({ pointsCost: 10, quantity: 1, stock: 5 })] })
    expect(() => preValidate(bad)).toThrowError(HttpError)
    expect(() => preValidate(good)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('pure helpers', () => {
  it('containsPhysicalLine detects physical products', () => {
    expect(containsPhysicalLine([makeLine({ type: ProductType.Virtual })])).toBe(false)
    expect(containsPhysicalLine([makeLine({ type: ProductType.Physical })])).toBe(true)
    expect(
      containsPhysicalLine([
        makeLine({ id: 'a', type: ProductType.Virtual }),
        makeLine({ id: 'b', type: ProductType.Physical }),
      ]),
    ).toBe(true)
  })

  it('isValidAddress validates presence and non-empty required fields', () => {
    expect(isValidAddress(undefined)).toBe(false)
    expect(isValidAddress(VALID_ADDRESS)).toBe(true)
    expect(isValidAddress({ recipient: '', phone: '1', detail: 'd' } as Address)).toBe(false)
    expect(isValidAddress({ recipient: 'a', phone: ' ', detail: 'd' } as Address)).toBe(false)
    expect(isValidAddress({ recipient: 'a', phone: '1', detail: '  ' } as Address)).toBe(false)
  })

  it('toStockCheckItems maps lines to stock-check items', () => {
    const items = toStockCheckItems([makeLine({ id: 'p1', name: 'X', quantity: 2, stock: 4 })])
    expect(items).toEqual([
      { productId: 'p1', name: 'X', requestedQuantity: 2, availableStock: 4 },
    ])
  })
})

// ---------------------------------------------------------------------------
// No side effects — 余额/库存/CDK/订单集合不变 (需求 5.4, 5.5, 6.3, 7.3)
// ---------------------------------------------------------------------------

describe('no side effects', () => {
  it('does not mutate the context on rejection (INSUFFICIENT_POINTS)', () => {
    const ctx = makeContext({
      balance: 5,
      lines: [makeLine({ id: 'p1', pointsCost: 10, quantity: 1, stock: 5 })],
    })
    const snapshot = JSON.parse(JSON.stringify(ctx))
    expect(() => validateRedemption(ctx)).toThrow()
    expect(JSON.parse(JSON.stringify(ctx))).toEqual(snapshot)
    // Frozen inputs guarantee no in-place writes occurred.
    expect(ctx.account.balance).toBe(5)
    expect(ctx.lines[0].product.stock).toBe(5)
  })

  it('does not mutate the context on success', () => {
    const ctx = makeContext({
      balance: 100,
      lines: [makeLine({ id: 'p1', type: ProductType.Physical, pointsCost: 10, quantity: 1, stock: 5 })],
      address: VALID_ADDRESS,
    })
    const snapshot = JSON.parse(JSON.stringify(ctx))
    expect(() => validateRedemption(ctx)).not.toThrow()
    expect(JSON.parse(JSON.stringify(ctx))).toEqual(snapshot)
  })

  it('sub-assertions are individually side-effect free', () => {
    const physicalCtx = makeContext({
      balance: 100,
      lines: [makeLine({ id: 'p1', type: ProductType.Physical, quantity: 1, stock: 5 })],
      address: VALID_ADDRESS,
    })
    const before = JSON.parse(JSON.stringify(physicalCtx))
    assertAddressForPhysical(physicalCtx)
    assertLinesWithinStock(physicalCtx.lines)
    expect(JSON.parse(JSON.stringify(physicalCtx))).toEqual(before)
  })
})
