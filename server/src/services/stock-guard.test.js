import { describe, it, expect } from 'vitest';
import { isWithinStock, findStockViolations, assertWithinStock, } from './stock-guard';
import { ErrorCode } from '../lib/errors';
// ---------------------------------------------------------------------------
// isWithinStock (pure predicate — 需求 5.2, 6.3)
// ---------------------------------------------------------------------------
describe('isWithinStock', () => {
    it('treats zero available stock (sold out) as never within stock (需求 5.2)', () => {
        expect(isWithinStock(1, 0)).toBe(false);
    });
    it('rejects requesting more than available (需求 6.3)', () => {
        expect(isWithinStock(4, 3)).toBe(false);
    });
    it('accepts requesting up to available stock', () => {
        expect(isWithinStock(3, 3)).toBe(true);
        expect(isWithinStock(1, 3)).toBe(true);
    });
    it('defensively rejects negative available stock', () => {
        expect(isWithinStock(1, -1)).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// findStockViolations / assertWithinStock
// ---------------------------------------------------------------------------
describe('findStockViolations', () => {
    it('returns empty when all items are within stock', () => {
        const items = [
            { productId: 'a', requestedQuantity: 2, availableStock: 5 },
            { productId: 'b', requestedQuantity: 1, availableStock: 1 },
        ];
        expect(findStockViolations(items)).toEqual([]);
    });
    it('collects every out-of-stock / over-stock item', () => {
        const items = [
            { productId: 'a', requestedQuantity: 2, availableStock: 5 },
            { productId: 'sold', requestedQuantity: 1, availableStock: 0 },
            { productId: 'over', requestedQuantity: 9, availableStock: 3 },
        ];
        expect(findStockViolations(items).map((i) => i.productId)).toEqual(['sold', 'over']);
    });
});
describe('assertWithinStock', () => {
    it('does not throw when all items are within stock', () => {
        expect(() => assertWithinStock([{ productId: 'a', requestedQuantity: 1, availableStock: 2 }])).not.toThrow();
    });
    it('throws INSUFFICIENT_STOCK on the first sold-out item (需求 5.2)', () => {
        expect.assertions(1);
        try {
            assertWithinStock([{ productId: 'a', name: 'A', requestedQuantity: 1, availableStock: 0 }]);
        }
        catch (err) {
            expect(err.errorCode).toBe(ErrorCode.InsufficientStock);
        }
    });
    it('throws INSUFFICIENT_STOCK when a quantity exceeds stock (需求 6.3)', () => {
        expect(() => assertWithinStock([{ productId: 'a', requestedQuantity: 5, availableStock: 3 }])).toThrow();
    });
});
