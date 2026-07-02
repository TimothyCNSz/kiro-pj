import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createCartRouter } from './cart';
import { createAuthMiddleware } from '../middleware/auth';
import { errorHandler, notFoundHandler } from '../middleware/error-handler';
import { SUCCESS_CODE } from '../lib/api';
import { Role } from '../lib/domain';
import { ErrorCode, ERROR_DEFINITIONS } from '../lib/errors';
import { HttpError } from '../middleware/http-error';
// ---------------------------------------------------------------------------
// Fakes — an in-memory cart service records calls and returns canned views;
// auth is stubbed with deterministic verifier + session manager (no real DB).
// ---------------------------------------------------------------------------
const emptyCart = { items: [], totalPoints: 0 };
class FakeCartService {
    view = emptyCart;
    /** Optional error to throw from the next call (to exercise error mapping). */
    nextError = null;
    getCalls = [];
    addCalls = [];
    updateCalls = [];
    removeCalls = [];
    maybeThrow() {
        if (this.nextError) {
            const err = this.nextError;
            this.nextError = null;
            throw err;
        }
    }
    async getCart(userId) {
        this.getCalls.push(userId);
        this.maybeThrow();
        return this.view;
    }
    async addItem(userId, productId, quantity) {
        this.addCalls.push({ userId, productId, quantity });
        this.maybeThrow();
        return this.view;
    }
    async updateItem(userId, productId, quantity) {
        this.updateCalls.push({ userId, productId, quantity });
        this.maybeThrow();
        return this.view;
    }
    async removeItem(userId, productId) {
        this.removeCalls.push({ userId, productId });
        this.maybeThrow();
        return this.view;
    }
}
class FakeVerifier {
    table;
    constructor(table) {
        this.table = table;
    }
    verify(token) {
        return this.table[token] ?? null;
    }
}
class FakeSessionManager {
    validSids;
    constructor(validSids) {
        this.validSids = validSids;
    }
    async validateAndTouch(sessionId) {
        if (!this.validSids.has(sessionId))
            return null;
        return {
            id: sessionId,
            userId: 'user-1',
            lastActiveAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
            revokedAt: null,
        };
    }
    async create() {
        return { sessionId: 'sx', expiresAt: new Date() };
    }
    async revoke() { }
    async refresh() {
        return null;
    }
    async touch() {
        return null;
    }
}
const PAYLOAD = { sub: 'user-1', sid: 'sid-ok', role: Role.Employee };
function buildHarness() {
    const cart = new FakeCartService();
    const authMiddleware = createAuthMiddleware({
        verifier: new FakeVerifier({ 'tok-ok': PAYLOAD }),
        sessionManager: new FakeSessionManager(new Set(['sid-ok'])),
    });
    const router = createCartRouter({ cartService: cart, authMiddleware });
    const app = express();
    app.use(express.json());
    app.use('/cart', router);
    app.use(notFoundHandler);
    app.use(errorHandler);
    return { app, cart };
}
const auth = (r) => r.set('Authorization', 'Bearer tok-ok');
const codeOf = (c) => ERROR_DEFINITIONS[c].appCode;
const sampleCart = {
    items: [{ productId: 'p1', name: 'Alpha', unitPoints: 100, quantity: 2, subtotal: 200 }],
    totalPoints: 200,
};
// ---------------------------------------------------------------------------
// Authentication (需求 1.15, 6.6)
// ---------------------------------------------------------------------------
describe('cart routes require authentication (需求 1.15, 6.6)', () => {
    let h;
    beforeEach(() => {
        h = buildHarness();
    });
    it('rejects GET /cart without a token', async () => {
        const res = await request(h.app).get('/cart');
        expect(res.status).toBe(401);
        expect(res.body.code).toBe(codeOf(ErrorCode.Unauthenticated));
    });
    it('rejects POST /cart/items without a token', async () => {
        const res = await request(h.app).post('/cart/items').send({ productId: 'p1', quantity: 1 });
        expect(res.status).toBe(401);
    });
    it('rejects PATCH /cart/items/:productId without a token', async () => {
        const res = await request(h.app).patch('/cart/items/p1').send({ quantity: 2 });
        expect(res.status).toBe(401);
    });
    it('rejects DELETE /cart/items/:productId without a token', async () => {
        const res = await request(h.app).delete('/cart/items/p1');
        expect(res.status).toBe(401);
    });
});
// ---------------------------------------------------------------------------
// GET /cart (需求 6.5, 6.6)
// ---------------------------------------------------------------------------
describe('GET /cart', () => {
    let h;
    beforeEach(() => {
        h = buildHarness();
    });
    it('returns the persisted cart view for the authenticated user (需求 6.5, 6.6)', async () => {
        h.cart.view = sampleCart;
        const res = await auth(request(h.app).get('/cart'));
        expect(res.status).toBe(200);
        expect(res.body.code).toBe(SUCCESS_CODE);
        expect(res.body.data).toEqual(sampleCart);
        expect(h.cart.getCalls).toEqual(['user-1']);
    });
    it('returns an empty cart envelope when nothing is stored', async () => {
        const res = await auth(request(h.app).get('/cart'));
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual(emptyCart);
    });
});
// ---------------------------------------------------------------------------
// POST /cart/items (需求 6.1)
// ---------------------------------------------------------------------------
describe('POST /cart/items', () => {
    let h;
    beforeEach(() => {
        h = buildHarness();
    });
    it('adds an item and returns 201 with the recomputed cart (需求 6.1, 6.5)', async () => {
        h.cart.view = sampleCart;
        const res = await auth(request(h.app).post('/cart/items')).send({ productId: 'p1', quantity: 2 });
        expect(res.status).toBe(201);
        expect(res.body.code).toBe(SUCCESS_CODE);
        expect(res.body.data).toEqual(sampleCart);
        expect(h.cart.addCalls).toEqual([{ userId: 'user-1', productId: 'p1', quantity: 2 }]);
    });
    it('rejects a missing productId with VALIDATION (422)', async () => {
        const res = await auth(request(h.app).post('/cart/items')).send({ quantity: 1 });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe(codeOf(ErrorCode.Validation));
        expect(h.cart.addCalls).toEqual([]);
    });
    it('rejects a blank productId with VALIDATION (422)', async () => {
        const res = await auth(request(h.app).post('/cart/items')).send({ productId: '   ', quantity: 1 });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe(codeOf(ErrorCode.Validation));
    });
    it('maps service errors to their HTTP status (e.g. non-existent product)', async () => {
        h.cart.nextError = new HttpError(ErrorCode.InvalidProductField, '商品不存在');
        const res = await auth(request(h.app).post('/cart/items')).send({ productId: 'ghost', quantity: 1 });
        expect(res.status).toBe(ERROR_DEFINITIONS[ErrorCode.InvalidProductField].httpStatus);
        expect(res.body.code).toBe(codeOf(ErrorCode.InvalidProductField));
    });
});
// ---------------------------------------------------------------------------
// PATCH /cart/items/:productId (需求 6.2)
// ---------------------------------------------------------------------------
describe('PATCH /cart/items/:productId', () => {
    let h;
    beforeEach(() => {
        h = buildHarness();
    });
    it('forwards the quantity to the service and returns the recomputed cart (需求 6.2)', async () => {
        h.cart.view = sampleCart;
        const res = await auth(request(h.app).patch('/cart/items/p1')).send({ quantity: 5 });
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual(sampleCart);
        expect(h.cart.updateCalls).toEqual([{ userId: 'user-1', productId: 'p1', quantity: 5 }]);
    });
    it('maps a VALIDATION error from the service to 422', async () => {
        h.cart.nextError = new HttpError(ErrorCode.Validation, '商品数量必须为不小于 1 的整数');
        const res = await auth(request(h.app).patch('/cart/items/p1')).send({ quantity: 0 });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe(codeOf(ErrorCode.Validation));
    });
});
// ---------------------------------------------------------------------------
// DELETE /cart/items/:productId (需求 6.4)
// ---------------------------------------------------------------------------
describe('DELETE /cart/items/:productId', () => {
    let h;
    beforeEach(() => {
        h = buildHarness();
    });
    it('removes the item and returns the recomputed cart (需求 6.4)', async () => {
        h.cart.view = emptyCart;
        const res = await auth(request(h.app).delete('/cart/items/p1'));
        expect(res.status).toBe(200);
        expect(res.body.code).toBe(SUCCESS_CODE);
        expect(res.body.data).toEqual(emptyCart);
        expect(h.cart.removeCalls).toEqual([{ userId: 'user-1', productId: 'p1' }]);
    });
});
