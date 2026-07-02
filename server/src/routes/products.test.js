import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createProductsRouter, parsePagination } from './products';
import { createAuthMiddleware } from '../middleware/auth';
import { errorHandler, notFoundHandler, NOT_FOUND_CODE } from '../middleware/error-handler';
import { SUCCESS_CODE } from '../lib/api';
import { Role, ProductType } from '../lib/domain';
import { ErrorCode, ERROR_DEFINITIONS } from '../lib/errors';
// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------
const emptyPage = { list: [], total: 0, page: 1, pageSize: 20 };
class FakeCatalogService {
    listResult = emptyPage;
    searchResult = emptyPage;
    detailResult = null;
    listCalls = [];
    searchCalls = [];
    getCalls = [];
    async listProducts(p) {
        this.listCalls.push(p);
        return this.listResult;
    }
    async searchProducts(keyword, p) {
        this.searchCalls.push({ keyword, ...p });
        return this.searchResult;
    }
    async getProduct(id) {
        this.getCalls.push(id);
        return this.detailResult;
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
    const catalog = new FakeCatalogService();
    const authMiddleware = createAuthMiddleware({
        verifier: new FakeVerifier({ 'tok-ok': PAYLOAD }),
        sessionManager: new FakeSessionManager(new Set(['sid-ok'])),
    });
    const router = createProductsRouter({ catalogService: catalog, authMiddleware });
    const app = express();
    app.use(express.json());
    app.use('/products', router);
    app.use(notFoundHandler);
    app.use(errorHandler);
    return { app, catalog };
}
const auth = (r) => r.set('Authorization', 'Bearer tok-ok');
const codeOf = (c) => ERROR_DEFINITIONS[c].appCode;
const sampleItem = {
    id: 'a',
    name: 'Mug',
    pointsCost: 10,
    imageUrl: 'https://cdn/x.jpg',
    isPlaceholder: false,
    stock: 3,
    available: true,
};
// ---------------------------------------------------------------------------
// parsePagination unit
// ---------------------------------------------------------------------------
describe('parsePagination', () => {
    it('defaults to page 1 / pageSize 20 for missing or invalid values', () => {
        expect(parsePagination({})).toEqual({ page: 1, pageSize: 20 });
        expect(parsePagination({ page: '0', pageSize: '-5' })).toEqual({ page: 1, pageSize: 20 });
        expect(parsePagination({ page: 'x' })).toEqual({ page: 1, pageSize: 20 });
    });
    it('parses valid values and clamps pageSize to the max', () => {
        expect(parsePagination({ page: '3', pageSize: '15' })).toEqual({ page: 3, pageSize: 15 });
        expect(parsePagination({ pageSize: '9999' })).toEqual({ page: 1, pageSize: 100 });
    });
});
// ---------------------------------------------------------------------------
// Authentication (需求 1.15)
// ---------------------------------------------------------------------------
describe('products routes require authentication (需求 1.15)', () => {
    let h;
    beforeEach(() => {
        h = buildHarness();
    });
    it('rejects GET /products without a token', async () => {
        const res = await request(h.app).get('/products');
        expect(res.status).toBe(401);
        expect(res.body.code).toBe(codeOf(ErrorCode.Unauthenticated));
    });
    it('rejects GET /products/search without a token', async () => {
        const res = await request(h.app).get('/products/search').query({ q: 'mug' });
        expect(res.status).toBe(401);
    });
    it('rejects GET /products/:id without a token', async () => {
        const res = await request(h.app).get('/products/a');
        expect(res.status).toBe(401);
    });
});
// ---------------------------------------------------------------------------
// GET /products
// ---------------------------------------------------------------------------
describe('GET /products', () => {
    let h;
    beforeEach(() => {
        h = buildHarness();
    });
    it('returns a paginated envelope of listed products (需求 4.1)', async () => {
        h.catalog.listResult = { list: [sampleItem], total: 1, page: 1, pageSize: 20 };
        const res = await auth(request(h.app).get('/products'));
        expect(res.status).toBe(200);
        expect(res.body.code).toBe(SUCCESS_CODE);
        expect(res.body.data).toEqual({ list: [sampleItem], total: 1, page: 1, pageSize: 20 });
    });
    it('forwards parsed pagination to the service', async () => {
        await auth(request(h.app).get('/products').query({ page: '2', pageSize: '5' }));
        expect(h.catalog.listCalls).toEqual([{ page: 2, pageSize: 5 }]);
    });
});
// ---------------------------------------------------------------------------
// GET /products/search
// ---------------------------------------------------------------------------
describe('GET /products/search', () => {
    let h;
    beforeEach(() => {
        h = buildHarness();
    });
    it('passes the keyword and pagination to the service (需求 4.3)', async () => {
        h.catalog.searchResult = { list: [sampleItem], total: 1, page: 1, pageSize: 20 };
        const res = await auth(request(h.app).get('/products/search').query({ q: 'mug', page: '1' }));
        expect(res.status).toBe(200);
        expect(res.body.data.list).toEqual([sampleItem]);
        expect(h.catalog.searchCalls).toEqual([{ keyword: 'mug', page: 1, pageSize: 20 }]);
    });
    it('returns an empty list envelope when nothing matches (需求 4.4)', async () => {
        h.catalog.searchResult = { list: [], total: 0, page: 1, pageSize: 20 };
        const res = await auth(request(h.app).get('/products/search').query({ q: 'zzz' }));
        expect(res.status).toBe(200);
        expect(res.body.data.list).toEqual([]);
        expect(res.body.data.total).toBe(0);
    });
    it('treats a missing q as an empty keyword', async () => {
        await auth(request(h.app).get('/products/search'));
        expect(h.catalog.searchCalls[0].keyword).toBe('');
    });
});
// ---------------------------------------------------------------------------
// GET /products/:id
// ---------------------------------------------------------------------------
describe('GET /products/:id', () => {
    let h;
    beforeEach(() => {
        h = buildHarness();
    });
    it('returns the product detail when found (需求 4.5)', async () => {
        const detail = {
            id: 'p',
            name: 'Gadget',
            description: 'desc',
            pointsCost: 55,
            type: ProductType.Virtual,
            stock: 2,
            available: true,
            imageUrl: 'https://cdn/u.jpg',
            isPlaceholder: false,
            images: [{ id: 'i1', url: 'https://cdn/u.jpg', isPrimary: true, sortOrder: 0 }],
        };
        h.catalog.detailResult = detail;
        const res = await auth(request(h.app).get('/products/p'));
        expect(res.status).toBe(200);
        expect(res.body.code).toBe(SUCCESS_CODE);
        expect(res.body.data).toEqual(detail);
        expect(h.catalog.getCalls).toEqual(['p']);
    });
    it('returns 404 when the product does not exist', async () => {
        h.catalog.detailResult = null;
        const res = await auth(request(h.app).get('/products/missing'));
        expect(res.status).toBe(404);
        expect(res.body.code).toBe(NOT_FOUND_CODE);
    });
});
