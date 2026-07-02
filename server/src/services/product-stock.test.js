import { describe, it, expect } from 'vitest';
import { ProductStockService, isSoldOut, } from './product-stock';
import { ProductType } from '../lib/domain';
// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------
/** 内存可用 CDK 计数替身：按 productId 记录可用数量并统计调用。 */
class FakeCdkCounter {
    counts;
    calls = [];
    constructor(counts = {}) {
        this.counts = counts;
    }
    async countAvailable(productId) {
        this.calls.push(productId);
        return this.counts[productId] ?? 0;
    }
}
const virtualProduct = (id, stock = 999) => ({
    id,
    type: ProductType.Virtual,
    stock, // cached value; must be ignored for virtual products
});
const physicalProduct = (id, stock) => ({
    id,
    type: ProductType.Physical,
    stock,
});
// ---------------------------------------------------------------------------
// isSoldOut (pure predicate)
// ---------------------------------------------------------------------------
describe('isSoldOut', () => {
    it('treats zero available stock as sold out (需求 5.1)', () => {
        expect(isSoldOut(0)).toBe(true);
    });
    it('treats positive available stock as available', () => {
        expect(isSoldOut(1)).toBe(false);
        expect(isSoldOut(50)).toBe(false);
    });
    it('defensively treats negative stock as sold out', () => {
        expect(isSoldOut(-1)).toBe(true);
    });
});
// ---------------------------------------------------------------------------
// ProductStockService
// ---------------------------------------------------------------------------
describe('ProductStockService.resolve', () => {
    it('derives virtual product stock from the available CDK count (需求 5.1, 12.2)', async () => {
        const counter = new FakeCdkCounter({ p1: 3 });
        const service = new ProductStockService({ cdkCounter: counter });
        // stock field on the view is intentionally large; must be ignored.
        expect(await service.resolve(virtualProduct('p1', 999))).toBe(3);
        expect(counter.calls).toEqual(['p1']);
    });
    it('returns the stock field directly for physical products (does not count CDKs)', async () => {
        const counter = new FakeCdkCounter({ p2: 7 });
        const service = new ProductStockService({ cdkCounter: counter });
        expect(await service.resolve(physicalProduct('p2', 12))).toBe(12);
        // physical products never touch the CDK counter
        expect(counter.calls).toEqual([]);
    });
});
describe('ProductStockService.getVirtualStock', () => {
    it('delegates to the injected CDK counter', async () => {
        const counter = new FakeCdkCounter({ p1: 5 });
        const service = new ProductStockService({ cdkCounter: counter });
        expect(await service.getVirtualStock('p1')).toBe(5);
        expect(await service.getVirtualStock('missing')).toBe(0);
    });
});
describe('ProductStockService.isSoldOut', () => {
    it('reports a virtual product with zero available CDKs as sold out (需求 5.1)', async () => {
        const service = new ProductStockService({ cdkCounter: new FakeCdkCounter({ p1: 0 }) });
        expect(await service.isSoldOut(virtualProduct('p1'))).toBe(true);
    });
    it('reports a virtual product with available CDKs as not sold out', async () => {
        const service = new ProductStockService({ cdkCounter: new FakeCdkCounter({ p1: 2 }) });
        expect(await service.isSoldOut(virtualProduct('p1'))).toBe(false);
    });
    it('reports a physical product with zero stock as sold out', async () => {
        const service = new ProductStockService({ cdkCounter: new FakeCdkCounter() });
        expect(await service.isSoldOut(physicalProduct('p2', 0))).toBe(true);
        expect(await service.isSoldOut(physicalProduct('p2', 4))).toBe(false);
    });
});
