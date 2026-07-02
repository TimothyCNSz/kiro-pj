// Unit tests for AdminProductService (创建/编辑/上下架, 需求 12.1, 12.3–12.6, 12.10)。
//
// 商品存储以内存替身注入，不触达真实数据库。

import { describe, expect, it } from 'vitest'

import { ProductStatus, ProductType } from '../lib/domain'
import { ErrorCode } from '../lib/errors'
import { resolveErrorCode } from '../middleware/http-error'
import type { NewProduct, Product } from '../db/schema'

import {
  AdminProductService,
  ProductValidationError,
  type ProductStore,
} from './admin-product-service'

/** 简单内存商品存储替身。 */
class FakeProductStore implements ProductStore {
  products = new Map<string, Product>()
  private seq = 0
  createCalls = 0

  async create(values: NewProduct): Promise<Product> {
    this.createCalls += 1
    const id = `prod-${(this.seq += 1)}`
    const row: Product = {
      id,
      name: values.name,
      imageUrl: values.imageUrl ?? null,
      description: values.description ?? '',
      pointsCost: values.pointsCost as number,
      type: values.type as Product['type'],
      status: (values.status ?? ProductStatus.Unlisted) as Product['status'],
      stock: (values.stock ?? 0) as number,
      version: 0,
      createdAt: new Date(),
    }
    this.products.set(id, row)
    return row
  }

  async updateById(id: string, patch: Partial<NewProduct>): Promise<Product | null> {
    const existing = this.products.get(id)
    if (!existing) return null
    const updated: Product = { ...existing, ...(patch as Partial<Product>) }
    this.products.set(id, updated)
    return updated
  }

  async findById(id: string): Promise<Product | null> {
    return this.products.get(id) ?? null
  }
}

function makeService() {
  const store = new FakeProductStore()
  const service = new AdminProductService({ store })
  return { service, store }
}

describe('AdminProductService.create', () => {
  it('saves name/description/pointsCost/stock/status/type (需求 12.1)', async () => {
    const { service } = makeService()
    const product = await service.create({
      name: '限量马克杯',
      description: '公司周边',
      imageUrl: 'https://cdn.example.com/media/products/x.jpg',
      pointsCost: 100,
      stock: 5,
      type: ProductType.Physical,
      status: ProductStatus.Listed,
    })

    expect(product.id).toBeTruthy()
    expect(product.name).toBe('限量马克杯')
    expect(product.description).toBe('公司周边')
    expect(product.pointsCost).toBe(100)
    expect(product.stock).toBe(5)
    expect(product.type).toBe(ProductType.Physical)
    expect(product.status).toBe(ProductStatus.Listed)
  })

  it('applies defaults: description="", imageUrl=null, stock=0, status=unlisted', async () => {
    const { service } = makeService()
    const product = await service.create({
      name: '虚拟礼品卡',
      pointsCost: 200,
      type: ProductType.Virtual,
    })

    expect(product.description).toBe('')
    expect(product.imageUrl).toBeNull()
    expect(product.stock).toBe(0)
    expect(product.status).toBe(ProductStatus.Unlisted)
  })

  it('does NOT require a CDK field for physical products (需求 12.6)', async () => {
    const { service } = makeService()
    // 实物商品创建入参不含任何 CDK 字段，创建正常成功。
    const product = await service.create({
      name: '实物 T 恤',
      pointsCost: 50,
      type: ProductType.Physical,
    })
    expect(product.type).toBe(ProductType.Physical)
  })

  it('rejects a negative pointsCost with INVALID_PRODUCT_FIELD (需求 12.5)', async () => {
    const { service, store } = makeService()
    await expect(
      service.create({ name: 'x', pointsCost: -1, type: ProductType.Physical }),
    ).rejects.toBeInstanceOf(ProductValidationError)
    try {
      await service.create({ name: 'x', pointsCost: -1, type: ProductType.Physical })
    } catch (err) {
      expect(resolveErrorCode(err)).toBe(ErrorCode.InvalidProductField)
      expect((err as ProductValidationError).fieldErrors.pointsCost).toBe('NEGATIVE_OR_INVALID')
    }
    // 校验失败不得创建商品。
    expect(store.createCalls).toBe(0)
  })

  it('rejects a negative stock with INVALID_PRODUCT_FIELD (需求 12.5)', async () => {
    const { service } = makeService()
    try {
      await service.create({ name: 'x', pointsCost: 10, stock: -3, type: ProductType.Virtual })
      throw new Error('expected rejection')
    } catch (err) {
      expect(resolveErrorCode(err)).toBe(ErrorCode.InvalidProductField)
      expect((err as ProductValidationError).fieldErrors.stock).toBe('NEGATIVE_OR_INVALID')
    }
  })

  it('rejects a non-integer pointsCost (需求 12.5)', async () => {
    const { service } = makeService()
    await expect(
      service.create({ name: 'x', pointsCost: 1.5, type: ProductType.Physical }),
    ).rejects.toBeInstanceOf(ProductValidationError)
  })

  it('rejects an empty name and an invalid type with itemized field errors', async () => {
    const { service } = makeService()
    try {
      await service.create({ name: '   ', pointsCost: 10, type: 'bogus' as ProductType })
      throw new Error('expected rejection')
    } catch (err) {
      const fe = (err as ProductValidationError).fieldErrors
      expect(fe.name).toBe('REQUIRED')
      expect(fe.type).toBe('INVALID_TYPE')
    }
  })
})

describe('AdminProductService.update', () => {
  async function seed(service: AdminProductService) {
    return service.create({
      name: 'orig',
      description: 'd',
      pointsCost: 100,
      stock: 5,
      type: ProductType.Physical,
      status: ProductStatus.Listed,
    })
  }

  it('updates only the provided fields (需求 12.3)', async () => {
    const { service } = makeService()
    const created = await seed(service)
    const updated = await service.update(created.id, { name: 'renamed', pointsCost: 250 })

    expect(updated).not.toBeNull()
    expect(updated!.name).toBe('renamed')
    expect(updated!.pointsCost).toBe(250)
    // 未提供的字段保持不变。
    expect(updated!.stock).toBe(5)
    expect(updated!.description).toBe('d')
    expect(updated!.status).toBe(ProductStatus.Listed)
  })

  it('returns null for a non-existent product', async () => {
    const { service } = makeService()
    const result = await service.update('missing', { name: 'x' })
    expect(result).toBeNull()
  })

  it('rejects a negative pointsCost on edit with INVALID_PRODUCT_FIELD (需求 12.5)', async () => {
    const { service } = makeService()
    const created = await seed(service)
    await expect(service.update(created.id, { pointsCost: -5 })).rejects.toMatchObject({
      errorCode: ErrorCode.InvalidProductField,
    })
  })

  it('rejects a negative stock on edit with INVALID_PRODUCT_FIELD (需求 12.5)', async () => {
    const { service } = makeService()
    const created = await seed(service)
    await expect(service.update(created.id, { stock: -1 })).rejects.toBeInstanceOf(
      ProductValidationError,
    )
  })

  it('allows updating description and imageUrl to explicit values (including null)', async () => {
    const { service } = makeService()
    const created = await seed(service)
    const updated = await service.update(created.id, { description: '', imageUrl: null })
    expect(updated!.description).toBe('')
    expect(updated!.imageUrl).toBeNull()
  })
})

describe('AdminProductService.setStatus', () => {
  async function seedListed(service: AdminProductService) {
    return service.create({
      name: 'p',
      pointsCost: 10,
      type: ProductType.Physical,
      status: ProductStatus.Listed,
    })
  }

  it('switches a product to unlisted (下架, 需求 12.4)', async () => {
    const { service } = makeService()
    const created = await seedListed(service)
    const updated = await service.setStatus(created.id, ProductStatus.Unlisted)
    expect(updated!.status).toBe(ProductStatus.Unlisted)
  })

  it('switches a product to listed (上架, 需求 12.4)', async () => {
    const { service } = makeService()
    const created = await service.create({
      name: 'p',
      pointsCost: 10,
      type: ProductType.Physical,
      status: ProductStatus.Unlisted,
    })
    const updated = await service.setStatus(created.id, ProductStatus.Listed)
    expect(updated!.status).toBe(ProductStatus.Listed)
  })

  it('returns null for a non-existent product', async () => {
    const { service } = makeService()
    expect(await service.setStatus('missing', ProductStatus.Listed)).toBeNull()
  })

  it('rejects an invalid status with INVALID_PRODUCT_FIELD', async () => {
    const { service } = makeService()
    const created = await seedListed(service)
    await expect(
      service.setStatus(created.id, 'archived' as ProductStatus),
    ).rejects.toBeInstanceOf(ProductValidationError)
  })
})

describe('AdminProductService — no physical delete (需求 12.10)', () => {
  it('does not expose any delete method (下线通过下架实现)', () => {
    const { service } = makeService()
    expect((service as unknown as Record<string, unknown>).delete).toBeUndefined()
    expect((service as unknown as Record<string, unknown>).remove).toBeUndefined()
    expect((service as unknown as Record<string, unknown>).destroy).toBeUndefined()
  })
})
