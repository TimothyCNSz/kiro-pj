import { describe, it, expect, beforeEach } from 'vitest';
import { buildRedemptionApplyEffects } from './redemption-effects';
import { OrderType, ProductType } from '../lib/domain';
class FakeEffectsTx {
    orders = [];
    cdkConsumptions = [];
    ledgerEntries = [];
    removeCartCalls = [];
    seq = 0;
    handle = { marker: 'tx-handle' };
    // --- core lock/decrement methods: unused by applyEffects, no-ops here ---
    async lockPointsAccount() {
        return null;
    }
    async lockProductsAscending() {
        return [];
    }
    async decrementProductStock() {
        return 1;
    }
    async decrementBalance() { }
    // --- side-effect methods (task 8.9) ---
    async insertOrder(order) {
        const id = `order-${++this.seq}`;
        this.orders.push({ ...order, id, items: [] });
        return id;
    }
    async insertOrderItems(orderId, items) {
        const order = this.orders.find((o) => o.id === orderId);
        if (!order)
            throw new Error(`unknown order ${orderId}`);
        order.items.push(...items);
    }
    async consumeCdks(productId, quantity, orderId) {
        this.cdkConsumptions.push({ productId, quantity, orderId });
    }
    async insertPointsLedger(entry) {
        this.ledgerEntries.push(entry);
    }
    async removeCartItems(userId, productIds) {
        this.removeCartCalls.push({ userId, productIds: [...productIds] });
    }
}
class FakeAlerter {
    calls = [];
    async triggerLowStock(productId, handle) {
        this.calls.push({ productId, handle });
    }
}
// ---------------------------------------------------------------------------
// Context builders
// ---------------------------------------------------------------------------
const USER = 'user-1';
function lockedProduct(over) {
    return {
        id: over.id,
        name: over.name ?? over.id,
        type: over.type ?? ProductType.Physical,
        pointsCost: over.pointsCost ?? 100,
        stock: over.stock ?? 10,
        version: over.version ?? 0,
    };
}
function line(product, quantity) {
    return { productId: product.id, quantity, product, cost: product.pointsCost * quantity };
}
function buildContext(lines, balance = 100_000, address) {
    const totalCost = lines.reduce((sum, l) => sum + l.cost, 0);
    const account = { userId: USER, balance, version: 0 };
    return { userId: USER, account, lines, totalCost, address };
}
// ---------------------------------------------------------------------------
// Orders: split by type + items (需求 7.9)
// ---------------------------------------------------------------------------
describe('buildRedemptionApplyEffects — order split & items', () => {
    let tx;
    let alerter;
    beforeEach(() => {
        tx = new FakeEffectsTx();
        alerter = new FakeAlerter();
    });
    it('splits a mixed redemption into a physical and a virtual order (需求 7.9)', async () => {
        const phys = lockedProduct({ id: 'p1', name: 'Mug', type: ProductType.Physical, pointsCost: 100, stock: 10 });
        const virt = lockedProduct({ id: 'v1', name: 'Gift Card', type: ProductType.Virtual, pointsCost: 250, stock: 10 });
        const ctx = buildContext([line(phys, 2), line(virt, 1)], 100_000, {
            recipient: 'Ada',
            phone: '123',
            detail: 'HQ',
        });
        const applyEffects = buildRedemptionApplyEffects({ alertService: alerter });
        await applyEffects(ctx, tx);
        expect(tx.orders).toHaveLength(2);
        const physicalOrder = tx.orders.find((o) => o.type === OrderType.Physical);
        const virtualOrder = tx.orders.find((o) => o.type === OrderType.Virtual);
        expect(physicalOrder.pointsSpent).toBe(200); // 100 * 2
        expect(physicalOrder.items).toEqual([
            { productId: 'p1', productName: 'Mug', quantity: 2, unitPoints: 100 },
        ]);
        // physical order persists the delivery address (需求 8.1)
        expect(physicalOrder.shippingAddress).toEqual({ recipient: 'Ada', phone: '123', detail: 'HQ' });
        expect(virtualOrder.pointsSpent).toBe(250); // 250 * 1
        expect(virtualOrder.items).toEqual([
            { productId: 'v1', productName: 'Gift Card', quantity: 1, unitPoints: 250 },
        ]);
        // virtual order does not carry an address (需求 9.1)
        expect(virtualOrder.shippingAddress).toBeNull();
    });
    it('creates a single order for a pure-physical redemption', async () => {
        const phys = lockedProduct({ id: 'p1', type: ProductType.Physical, pointsCost: 50, stock: 10 });
        const ctx = buildContext([line(phys, 3)], 100_000, { recipient: 'a', phone: 'b', detail: 'c' });
        await buildRedemptionApplyEffects({ alertService: alerter })(ctx, tx);
        expect(tx.orders).toHaveLength(1);
        expect(tx.orders[0].type).toBe(OrderType.Physical);
        expect(tx.cdkConsumptions).toEqual([]); // no CDK for physical
    });
});
// ---------------------------------------------------------------------------
// CDK consumption for virtual orders (需求 9.2)
// ---------------------------------------------------------------------------
describe('buildRedemptionApplyEffects — virtual CDK consumption (需求 9.2)', () => {
    it('consumes one CDK per virtual unit, associated with the virtual order', async () => {
        const tx = new FakeEffectsTx();
        const alerter = new FakeAlerter();
        const virt = lockedProduct({ id: 'v1', type: ProductType.Virtual, pointsCost: 30, stock: 10 });
        const ctx = buildContext([line(virt, 3)]);
        await buildRedemptionApplyEffects({ alertService: alerter })(ctx, tx);
        const virtualOrder = tx.orders.find((o) => o.type === OrderType.Virtual);
        expect(tx.cdkConsumptions).toEqual([
            { productId: 'v1', quantity: 3, orderId: virtualOrder.id },
        ]);
    });
    it('does not consume CDKs for physical-only redemptions', async () => {
        const tx = new FakeEffectsTx();
        const phys = lockedProduct({ id: 'p1', type: ProductType.Physical, pointsCost: 10, stock: 10 });
        const ctx = buildContext([line(phys, 1)], 100_000, { recipient: 'a', phone: 'b', detail: 'c' });
        await buildRedemptionApplyEffects({ alertService: new FakeAlerter() })(ctx, tx);
        expect(tx.cdkConsumptions).toEqual([]);
    });
});
// ---------------------------------------------------------------------------
// Points ledger (需求 10.2, 20.2)
// ---------------------------------------------------------------------------
describe('buildRedemptionApplyEffects — points ledger', () => {
    it('records one redemption ledger entry with delta and balanceAfter', async () => {
        const tx = new FakeEffectsTx();
        const p1 = lockedProduct({ id: 'p1', type: ProductType.Physical, pointsCost: 100, stock: 10 });
        const p2 = lockedProduct({ id: 'p2', type: ProductType.Physical, pointsCost: 250, stock: 10 });
        const ctx = buildContext([line(p1, 2), line(p2, 1)], 1000, {
            recipient: 'a',
            phone: 'b',
            detail: 'c',
        });
        await buildRedemptionApplyEffects({ alertService: new FakeAlerter() })(ctx, tx);
        expect(tx.ledgerEntries).toHaveLength(1);
        expect(tx.ledgerEntries[0]).toEqual({
            userId: USER,
            delta: -450, // -(100*2 + 250*1)
            reason: 'redemption',
            balanceAfter: 550, // 1000 - 450
        });
    });
});
// ---------------------------------------------------------------------------
// Cart cleanup (需求 7.5)
// ---------------------------------------------------------------------------
describe('buildRedemptionApplyEffects — cart cleanup (需求 7.5)', () => {
    const build = (over = {}) => {
        const p1 = lockedProduct({ id: 'p1', pointsCost: 10, stock: 10 });
        const p2 = lockedProduct({ id: 'p2', pointsCost: 10, stock: 10 });
        return buildContext([line(p1, 1), line(p2, 1)], 100_000, {
            recipient: 'a',
            phone: 'b',
            detail: 'c',
            ...over,
        });
    };
    it('removes redeemed products from the cart when enabled (checkout)', async () => {
        const tx = new FakeEffectsTx();
        await buildRedemptionApplyEffects({ alertService: new FakeAlerter(), removeRedeemedCartItems: true })(build(), tx);
        expect(tx.removeCartCalls).toEqual([{ userId: USER, productIds: ['p1', 'p2'] }]);
    });
    it('defaults to removing redeemed cart items', async () => {
        const tx = new FakeEffectsTx();
        await buildRedemptionApplyEffects({ alertService: new FakeAlerter() })(build(), tx);
        expect(tx.removeCartCalls).toHaveLength(1);
    });
    it('does not touch the cart for instant redemptions (removeRedeemedCartItems=false)', async () => {
        const tx = new FakeEffectsTx();
        await buildRedemptionApplyEffects({
            alertService: new FakeAlerter(),
            removeRedeemedCartItems: false,
        })(build(), tx);
        expect(tx.removeCartCalls).toEqual([]);
    });
});
// ---------------------------------------------------------------------------
// Low-stock alert triggered exactly when stock hits 0 (需求 5.3)
// ---------------------------------------------------------------------------
describe('buildRedemptionApplyEffects — low-stock alert (需求 5.3)', () => {
    it('triggers a low-stock alert only for products whose stock reaches 0, passing the tx handle', async () => {
        const tx = new FakeEffectsTx();
        const alerter = new FakeAlerter();
        // p1: stock 5, qty 5 -> reaches 0 (alert). p2: stock 5, qty 2 -> 3 left (no alert).
        const p1 = lockedProduct({ id: 'p1', type: ProductType.Physical, pointsCost: 10, stock: 5 });
        const p2 = lockedProduct({ id: 'p2', type: ProductType.Physical, pointsCost: 10, stock: 5 });
        const ctx = buildContext([line(p1, 5), line(p2, 2)], 100_000, {
            recipient: 'a',
            phone: 'b',
            detail: 'c',
        });
        await buildRedemptionApplyEffects({ alertService: alerter })(ctx, tx);
        expect(alerter.calls).toEqual([{ productId: 'p1', handle: tx.handle }]);
    });
    it('triggers for virtual products whose available stock reaches 0', async () => {
        const tx = new FakeEffectsTx();
        const alerter = new FakeAlerter();
        const virt = lockedProduct({ id: 'v1', type: ProductType.Virtual, pointsCost: 10, stock: 2 });
        const ctx = buildContext([line(virt, 2)]);
        await buildRedemptionApplyEffects({ alertService: alerter })(ctx, tx);
        expect(alerter.calls.map((c) => c.productId)).toEqual(['v1']);
    });
    it('does not trigger any alert when no stock reaches 0', async () => {
        const tx = new FakeEffectsTx();
        const alerter = new FakeAlerter();
        const p1 = lockedProduct({ id: 'p1', type: ProductType.Physical, pointsCost: 10, stock: 10 });
        const ctx = buildContext([line(p1, 1)], 100_000, { recipient: 'a', phone: 'b', detail: 'c' });
        await buildRedemptionApplyEffects({ alertService: alerter })(ctx, tx);
        expect(alerter.calls).toEqual([]);
    });
});
