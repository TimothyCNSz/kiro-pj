import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RedemptionService, ConcurrencyConflictError, normalizeItems, assertSufficientPoints, assertSufficientStock, } from './redemption-service';
import { ErrorCode } from '../lib/errors';
import { ProductType } from '../lib/domain';
class FakeRedemptionStore {
    accounts = new Map();
    products = new Map();
    /**
     * productId -> number of times to inject a version bump right before the next
     * decrementProductStock, simulating a concurrent modification between lock and
     * update (forces affected=0 → ConcurrencyConflictError).
     */
    pendingConflicts = new Map();
    /** Order in which product rows were locked during the last/any transaction. */
    lockOrder = [];
    seedAccount(userId, balance, version = 0) {
        this.accounts.set(userId, { balance, version });
    }
    seedProduct(p) {
        this.products.set(p.id, {
            id: p.id,
            name: p.name ?? p.id,
            type: p.type ?? ProductType.Physical,
            pointsCost: p.pointsCost,
            stock: p.stock,
            version: p.version ?? 0,
        });
    }
    /** Schedule `times` synthetic version conflicts for a product. */
    scheduleConflict(productId, times) {
        this.pendingConflicts.set(productId, times);
    }
    async transaction(fn) {
        // Snapshot for all-or-nothing rollback semantics.
        const accountsSnap = new Map([...this.accounts].map(([k, v]) => [k, { ...v }]));
        const productsSnap = new Map([...this.products].map(([k, v]) => [k, { ...v }]));
        const tx = new FakeRedemptionTx(this);
        try {
            return await fn(tx);
        }
        catch (err) {
            // Roll back: restore pre-transaction snapshot (no partial mutations).
            this.accounts.clear();
            for (const [k, v] of accountsSnap)
                this.accounts.set(k, v);
            this.products.clear();
            for (const [k, v] of productsSnap)
                this.products.set(k, v);
            throw err;
        }
    }
}
class FakeRedemptionTx {
    store;
    constructor(store) {
        this.store = store;
    }
    async lockPointsAccount(userId) {
        const acc = this.store.accounts.get(userId);
        return acc ? { userId, balance: acc.balance, version: acc.version } : null;
    }
    async lockProductsAscending(productIds) {
        const sorted = [...productIds].sort();
        const rows = [];
        for (const id of sorted) {
            const p = this.store.products.get(id);
            if (!p)
                continue;
            this.store.lockOrder.push(id);
            rows.push({
                id: p.id,
                name: p.name,
                type: p.type,
                pointsCost: p.pointsCost,
                stock: p.stock,
                version: p.version,
            });
        }
        return rows;
    }
    async decrementProductStock(productId, quantity, expectedVersion) {
        // Inject a synthetic concurrent version bump if scheduled.
        const remaining = this.store.pendingConflicts.get(productId) ?? 0;
        if (remaining > 0) {
            const p = this.store.products.get(productId);
            if (p)
                p.version += 1;
            this.store.pendingConflicts.set(productId, remaining - 1);
        }
        const product = this.store.products.get(productId);
        if (!product || product.version !== expectedVersion) {
            return 0; // version mismatch → concurrency conflict
        }
        product.stock -= quantity;
        product.version += 1;
        return 1;
    }
    async decrementBalance(userId, amount) {
        const acc = this.store.accounts.get(userId);
        if (!acc)
            throw new Error(`account ${userId} missing`);
        acc.balance -= amount;
        acc.version += 1;
    }
    // Side-effect operations (task 8.9) — not exercised by the core tests below,
    // implemented as no-ops so the fake satisfies the extended RedemptionTx.
    async insertOrder() {
        return 'order-fake';
    }
    async insertOrderItems() { }
    async consumeCdks() { }
    async insertPointsLedger() { }
    async removeCartItems() { }
    get handle() {
        return this.store;
    }
}
const USER = 'user-1';
function buildStore() {
    const store = new FakeRedemptionStore();
    store.seedAccount(USER, 1000);
    store.seedProduct({ id: 'p1', name: 'Alpha', pointsCost: 100, stock: 10 });
    store.seedProduct({ id: 'p2', name: 'Beta', pointsCost: 250, stock: 5 });
    return store;
}
// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
describe('normalizeItems', () => {
    it('merges duplicate productIds by summing quantity and sorts ascending', () => {
        const result = normalizeItems([
            { productId: 'b', quantity: 1 },
            { productId: 'a', quantity: 2 },
            { productId: 'b', quantity: 3 },
        ]);
        expect(result).toEqual([
            { productId: 'a', quantity: 2 },
            { productId: 'b', quantity: 4 },
        ]);
    });
    it('rejects an empty item list with VALIDATION', () => {
        expect(() => normalizeItems([])).toThrowError(expect.objectContaining({ errorCode: ErrorCode.Validation }));
    });
    it.each([0, -1, 1.5, Number.NaN])('rejects invalid quantity %p with VALIDATION', (qty) => {
        expect(() => normalizeItems([{ productId: 'p1', quantity: qty }])).toThrowError(expect.objectContaining({ errorCode: ErrorCode.Validation }));
    });
});
describe('assertSufficientPoints / assertSufficientStock', () => {
    const account = { userId: USER, balance: 100, version: 0 };
    const product = {
        id: 'p1',
        name: 'Alpha',
        type: ProductType.Physical,
        pointsCost: 50,
        stock: 3,
        version: 0,
    };
    it('passes when balance >= total cost', () => {
        expect(() => assertSufficientPoints(account, 100)).not.toThrow();
    });
    it('rejects when balance < total cost with INSUFFICIENT_POINTS', () => {
        expect(() => assertSufficientPoints(account, 101)).toThrowError(expect.objectContaining({ errorCode: ErrorCode.InsufficientPoints }));
    });
    it('passes when each quantity <= stock', () => {
        expect(() => assertSufficientStock([{ productId: 'p1', quantity: 3, product, cost: 150 }])).not.toThrow();
    });
    it('rejects when a quantity exceeds stock with INSUFFICIENT_STOCK', () => {
        expect(() => assertSufficientStock([{ productId: 'p1', quantity: 4, product, cost: 200 }])).toThrowError(expect.objectContaining({ errorCode: ErrorCode.InsufficientStock }));
    });
});
// ---------------------------------------------------------------------------
// RedemptionService.checkout — happy path + relative decrements
// ---------------------------------------------------------------------------
describe('RedemptionService.checkout (success + relative decrements)', () => {
    let store;
    let service;
    beforeEach(() => {
        store = buildStore();
        service = new RedemptionService({ store });
    });
    it('relatively decrements stock (stock - qty) and balance (balance - totalCost)', async () => {
        const result = await service.checkout(USER, [
            { productId: 'p1', quantity: 2 },
            { productId: 'p2', quantity: 1 },
        ]);
        // totalCost = 100*2 + 250*1 = 450
        expect(result.totalCost).toBe(450);
        expect(result.balanceBefore).toBe(1000);
        expect(result.balanceAfter).toBe(550);
        expect(store.accounts.get(USER).balance).toBe(550);
        expect(store.products.get('p1').stock).toBe(8); // 10 - 2
        expect(store.products.get('p2').stock).toBe(4); // 5 - 1
        // versions bumped by the conditional updates
        expect(store.products.get('p1').version).toBe(1);
        expect(store.products.get('p2').version).toBe(1);
        expect(store.accounts.get(USER).version).toBe(1);
    });
    it('locks products in productId-ascending order (deadlock avoidance, 需求 7.10)', async () => {
        await service.checkout(USER, [
            { productId: 'p2', quantity: 1 },
            { productId: 'p1', quantity: 1 },
        ]);
        expect(store.lockOrder).toEqual(['p1', 'p2']);
    });
    it('merges duplicate product lines before locking/decrementing', async () => {
        const result = await service.checkout(USER, [
            { productId: 'p1', quantity: 2 },
            { productId: 'p1', quantity: 3 },
        ]);
        expect(result.totalCost).toBe(500); // 100 * 5
        expect(store.products.get('p1').stock).toBe(5); // 10 - 5
    });
});
// ---------------------------------------------------------------------------
// Atomicity — all-or-nothing (需求 7.8, 19.2)
// ---------------------------------------------------------------------------
describe('RedemptionService.checkout atomicity (all-or-nothing)', () => {
    let store;
    let service;
    beforeEach(() => {
        store = buildStore();
        service = new RedemptionService({ store });
    });
    it('leaves balance and ALL stock unchanged when a later line exceeds stock', async () => {
        // Ample balance so the stock check (not the points check) is the failing one.
        store.seedAccount(USER, 100000);
        // p1 ok (qty 1 <= 10) but p2 requests 6 > stock 5 → whole tx must roll back.
        await expect(service.checkout(USER, [
            { productId: 'p1', quantity: 1 },
            { productId: 'p2', quantity: 6 },
        ])).rejects.toMatchObject({ errorCode: ErrorCode.InsufficientStock });
        expect(store.accounts.get(USER).balance).toBe(100000); // unchanged
        expect(store.products.get('p1').stock).toBe(10); // unchanged (no partial decrement)
        expect(store.products.get('p2').stock).toBe(5); // unchanged
    });
    it('leaves everything unchanged when points are insufficient', async () => {
        store.seedAccount(USER, 300); // less than totalCost 450
        await expect(service.checkout(USER, [
            { productId: 'p1', quantity: 2 },
            { productId: 'p2', quantity: 1 },
        ])).rejects.toMatchObject({ errorCode: ErrorCode.InsufficientPoints });
        expect(store.accounts.get(USER).balance).toBe(300);
        expect(store.products.get('p1').stock).toBe(10);
        expect(store.products.get('p2').stock).toBe(5);
    });
    it('rolls back stock/balance when an applyEffects hook throws (原子性延伸至副作用)', async () => {
        const failing = new RedemptionService({
            store,
            hooks: {
                applyEffects: async () => {
                    throw new Error('side-effect failure');
                },
            },
        });
        await expect(failing.checkout(USER, [{ productId: 'p1', quantity: 2 }])).rejects.toThrow('side-effect failure');
        expect(store.accounts.get(USER).balance).toBe(1000); // rolled back
        expect(store.products.get('p1').stock).toBe(10); // rolled back
    });
    it('rolls back and skips core mutation when preValidate hook throws', async () => {
        const applyEffects = vi.fn();
        const failing = new RedemptionService({
            store,
            hooks: {
                preValidate: () => {
                    throw new Error('missing address');
                },
                applyEffects,
            },
        });
        await expect(failing.checkout(USER, [{ productId: 'p1', quantity: 1 }])).rejects.toThrow('missing address');
        expect(store.products.get('p1').stock).toBe(10); // no decrement
        expect(store.accounts.get(USER).balance).toBe(1000);
        expect(applyEffects).not.toHaveBeenCalled(); // never reached mutation stage
    });
});
// ---------------------------------------------------------------------------
// Concurrency conflict + bounded retry (需求 7.10, 19.4)
// ---------------------------------------------------------------------------
describe('RedemptionService.checkout concurrency retry', () => {
    it('retries after a version conflict and eventually succeeds', async () => {
        const store = buildStore();
        const service = new RedemptionService({ store, maxRetries: 3 });
        // Inject exactly one synthetic version conflict on the first decrement.
        store.scheduleConflict('p1', 1);
        const result = await service.checkout(USER, [{ productId: 'p1', quantity: 2 }]);
        expect(result.totalCost).toBe(200);
        expect(store.products.get('p1').stock).toBe(8); // decremented once, no double-decrement
        expect(store.accounts.get(USER).balance).toBe(800);
    });
    it('throws ConcurrencyConflictError after exhausting retries', async () => {
        const store = buildStore();
        const service = new RedemptionService({ store, maxRetries: 2 });
        // More conflicts than retries → never succeeds.
        store.scheduleConflict('p1', 99);
        await expect(service.checkout(USER, [{ productId: 'p1', quantity: 2 }])).rejects.toBeInstanceOf(ConcurrencyConflictError);
        // Nothing committed after final rollback.
        expect(store.products.get('p1').stock).toBe(10);
        expect(store.accounts.get(USER).balance).toBe(1000);
    });
    it('maps ConcurrencyConflictError to the CONCURRENCY_CONFLICT error code', () => {
        expect(new ConcurrencyConflictError().errorCode).toBe(ErrorCode.ConcurrencyConflict);
    });
});
// ---------------------------------------------------------------------------
// Missing / invalid inputs
// ---------------------------------------------------------------------------
describe('RedemptionService.checkout input validation', () => {
    it('rejects a non-existent product with INVALID_PRODUCT_FIELD', async () => {
        const store = buildStore();
        const service = new RedemptionService({ store });
        await expect(service.checkout(USER, [{ productId: 'ghost', quantity: 1 }])).rejects.toMatchObject({ errorCode: ErrorCode.InvalidProductField });
    });
    it('rejects when the points account does not exist', async () => {
        const store = buildStore();
        store.accounts.delete(USER);
        const service = new RedemptionService({ store });
        await expect(service.checkout(USER, [{ productId: 'p1', quantity: 1 }])).rejects.toMatchObject({ errorCode: ErrorCode.InsufficientPoints });
    });
    it('passes address and context through to the preValidate seam (task 8.4)', async () => {
        const store = buildStore();
        const seen = [];
        const service = new RedemptionService({
            store,
            hooks: { preValidate: (ctx) => void seen.push(ctx) },
        });
        const address = { recipient: 'Ada', phone: '123', detail: 'HQ' };
        await service.checkout(USER, [{ productId: 'p1', quantity: 1 }], { address });
        expect(seen).toHaveLength(1);
        expect(seen[0].address).toEqual(address);
        expect(seen[0].totalCost).toBe(100);
        expect(seen[0].lines).toHaveLength(1);
    });
});
