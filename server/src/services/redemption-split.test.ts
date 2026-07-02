import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

import { splitOrdersByType, type OrderDraft } from './redemption-split'
import type { RedemptionLine, LockedProduct } from './redemption-service'
import { OrderType, ProductType } from '../lib/domain'

// ---------------------------------------------------------------------------
// Test helpers: build RedemptionLine fixtures without touching the DB.
// splitOrdersByType is a pure function over already-locked/validated lines.
// ---------------------------------------------------------------------------

function makeLine(
  id: string,
  type: ProductType,
  pointsCost: number,
  quantity: number,
  name = `商品-${id}`,
): RedemptionLine {
  const product: LockedProduct = {
    id,
    name,
    type,
    pointsCost,
    stock: 999,
    version: 0,
  }
  return { productId: id, quantity, product, cost: pointsCost * quantity }
}

const totalOf = (lines: readonly RedemptionLine[]): number =>
  lines.reduce((sum, l) => sum + l.cost, 0)

const sumPoints = (drafts: readonly OrderDraft[]): number =>
  drafts.reduce((sum, d) => sum + d.pointsSpent, 0)

// ---------------------------------------------------------------------------
// Unit tests — representative cases (需求 7.9)
// ---------------------------------------------------------------------------

describe('splitOrdersByType — 按类型拆单（需求 7.9）', () => {
  it('空明细 → 不生成任何订单草稿', () => {
    expect(splitOrdersByType([])).toEqual([])
  })

  it('纯虚拟 → 恰生成一个虚拟订单，含全部虚拟项', () => {
    const lines = [
      makeLine('v1', ProductType.Virtual, 50, 2),
      makeLine('v2', ProductType.Virtual, 30, 1),
    ]
    const drafts = splitOrdersByType(lines)

    expect(drafts).toHaveLength(1)
    expect(drafts[0].type).toBe(OrderType.Virtual)
    expect(drafts[0].items.map((i) => i.productId)).toEqual(['v1', 'v2'])
    expect(drafts[0].pointsSpent).toBe(50 * 2 + 30) // 130
    // 积分守恒
    expect(sumPoints(drafts)).toBe(totalOf(lines))
  })

  it('纯实物 → 恰生成一个实物订单，含全部实物项', () => {
    const lines = [
      makeLine('p1', ProductType.Physical, 100, 1),
      makeLine('p2', ProductType.Physical, 40, 3),
    ]
    const drafts = splitOrdersByType(lines)

    expect(drafts).toHaveLength(1)
    expect(drafts[0].type).toBe(OrderType.Physical)
    expect(drafts[0].items.map((i) => i.productId)).toEqual(['p1', 'p2'])
    expect(drafts[0].pointsSpent).toBe(100 + 40 * 3) // 220
    expect(sumPoints(drafts)).toBe(totalOf(lines))
  })

  it('混合 → 生成两个订单，订单项按类型正确归类，实物在前虚拟在后', () => {
    const lines = [
      makeLine('p1', ProductType.Physical, 100, 1),
      makeLine('v1', ProductType.Virtual, 50, 2),
      makeLine('p2', ProductType.Physical, 25, 4),
      makeLine('v2', ProductType.Virtual, 10, 1),
    ]
    const drafts = splitOrdersByType(lines)

    expect(drafts).toHaveLength(2)

    const [physical, virtual] = drafts
    expect(physical.type).toBe(OrderType.Physical)
    expect(virtual.type).toBe(OrderType.Virtual)

    // 归类正确：实物项只在实物订单，虚拟项只在虚拟订单
    expect(physical.items.map((i) => i.productId).sort()).toEqual(['p1', 'p2'])
    expect(virtual.items.map((i) => i.productId).sort()).toEqual(['v1', 'v2'])

    expect(physical.pointsSpent).toBe(100 + 25 * 4) // 200
    expect(virtual.pointsSpent).toBe(50 * 2 + 10) // 110

    // 积分守恒：两订单之和 = 应付总额
    expect(sumPoints(drafts)).toBe(totalOf(lines)) // 310
  })

  it('订单项快照 name / unitPoints 取自锁定商品', () => {
    const lines = [makeLine('p1', ProductType.Physical, 100, 2, '实物礼盒')]
    const [draft] = splitOrdersByType(lines)

    expect(draft.items[0]).toEqual({
      productId: 'p1',
      name: '实物礼盒',
      quantity: 2,
      unitPoints: 100,
    })
  })
})

// ---------------------------------------------------------------------------
// Property-based test — Property 15: 混合兑换按类型拆分且积分守恒
// Validates: Requirements 7.9
// ---------------------------------------------------------------------------

describe('splitOrdersByType — Property 15（积分守恒与类型归类）', () => {
  const lineArb = fc.record({
    id: fc.string({ minLength: 1, maxLength: 8 }),
    type: fc.constantFrom(ProductType.Physical, ProductType.Virtual),
    pointsCost: fc.integer({ min: 1, max: 10_000 }),
    quantity: fc.integer({ min: 1, max: 50 }),
  })

  it('Property 15: 每项正确归类、只为出现的类型建单、Σ pointsSpent = 应付总额', () => {
    fc.assert(
      fc.property(fc.array(lineArb, { maxLength: 30 }), (raw) => {
        // 去重 productId，避免同 id 干扰归类断言（数量合并属于 normalizeItems 职责）
        const seen = new Set<string>()
        const specs = raw.filter((r) => {
          if (seen.has(r.id)) return false
          seen.add(r.id)
          return true
        })
        const lines = specs.map((s) => makeLine(s.id, s.type, s.pointsCost, s.quantity))

        const drafts = splitOrdersByType(lines)

        const hasPhysical = specs.some((s) => s.type === ProductType.Physical)
        const hasVirtual = specs.some((s) => s.type === ProductType.Virtual)
        const expectedCount = (hasPhysical ? 1 : 0) + (hasVirtual ? 1 : 0)

        // 只为出现的类型建单（0 / 1 / 2）
        expect(drafts).toHaveLength(expectedCount)

        // 出现的类型顺序固定：实物在前、虚拟在后
        expect(drafts.map((d) => d.type)).toEqual(
          [
            hasPhysical ? OrderType.Physical : null,
            hasVirtual ? OrderType.Virtual : null,
          ].filter((t): t is OrderType => t !== null),
        )

        for (const draft of drafts) {
          const expectedType =
            draft.type === OrderType.Physical ? ProductType.Physical : ProductType.Virtual
          // 每个订单项按其商品类型正确归类
          for (const item of draft.items) {
            const spec = specs.find((s) => s.id === item.productId)!
            expect(spec.type).toBe(expectedType)
          }
          // 单个订单 pointsSpent = 其订单项 unitPoints × quantity 之和
          const localSum = draft.items.reduce((s, i) => s + i.unitPoints * i.quantity, 0)
          expect(draft.pointsSpent).toBe(localSum)
        }

        // 积分守恒：Σ pointsSpent === 应付总额
        expect(sumPoints(drafts)).toBe(totalOf(lines))

        // 无遗漏、无重复：拆分后订单项总数 = 输入行数
        const itemCount = drafts.reduce((s, d) => s + d.items.length, 0)
        expect(itemCount).toBe(lines.length)
      }),
    )
  })
})
