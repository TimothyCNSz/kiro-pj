import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAdminCdksRouter, ADD_CDKS_OK_MESSAGE } from './admin-cdks';
import { createAuthMiddleware } from '../middleware/auth';
import { errorHandler, notFoundHandler } from '../middleware/error-handler';
import { HttpError } from '../middleware/http-error';
import { SUCCESS_CODE } from '../lib/api';
import { Role } from '../lib/domain';
import { ErrorCode, ERROR_DEFINITIONS } from '../lib/errors';
// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------
class FakeCdkService {
    calls = [];
    result = { added: 2, availableStock: 5 };
    error = null;
    async addCdks(productId, codes) {
        this.calls.push({ productId, codes });
        if (this.error)
            throw this.error;
        return this.result;
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
const ADMIN_TOKEN = 'tok-admin';
const EMPLOYEE_TOKEN = 'tok-employee';
function buildHarness() {
    const cdkService = new FakeCdkService();
    const authMiddleware = createAuthMiddleware({
        verifier: new FakeVerifier({
            [ADMIN_TOKEN]: { sub: 'admin-1', sid: 'sid-admin', role: Role.Admin },
            [EMPLOYEE_TOKEN]: { sub: 'emp-1', sid: 'sid-emp', role: Role.Employee },
        }),
        sessionManager: new FakeSessionManager(new Set(['sid-admin', 'sid-emp'])),
    });
    const router = createAdminCdksRouter({ cdkService, authMiddleware });
    const app = express();
    app.use(express.json());
    app.use('/admin/products', router);
    app.use(notFoundHandler);
    app.use(errorHandler);
    return { app, cdkService };
}
const codeOf = (c) => ERROR_DEFINITIONS[c].appCode;
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /admin/products/:id/cdks', () => {
    let h;
    beforeEach(() => {
        h = buildHarness();
    });
    it('rejects unauthenticated requests with 401 (需求 20.1, 20.3)', async () => {
        const res = await request(h.app).post('/admin/products/v1/cdks').send({ codes: ['A'] });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe(codeOf(ErrorCode.Unauthenticated));
        expect(h.cdkService.calls).toEqual([]);
    });
    it('rejects non-admin (employee) requests with 403 (需求 3.3, 20.4)', async () => {
        const res = await request(h.app)
            .post('/admin/products/v1/cdks')
            .set('Authorization', `Bearer ${EMPLOYEE_TOKEN}`)
            .send({ codes: ['A'] });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe(codeOf(ErrorCode.Forbidden));
        expect(h.cdkService.calls).toEqual([]);
    });
    it('adds CDKs for an admin and returns 201 + result envelope (需求 12.2, 5.1)', async () => {
        h.cdkService.result = { added: 3, availableStock: 8 };
        const res = await request(h.app)
            .post('/admin/products/v1/cdks')
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
            .send({ codes: ['A', 'B', 'C'] });
        expect(res.status).toBe(201);
        expect(res.body.code).toBe(SUCCESS_CODE);
        expect(res.body.message).toBe(ADD_CDKS_OK_MESSAGE);
        expect(res.body.data).toEqual({ added: 3, availableStock: 8 });
        expect(h.cdkService.calls).toEqual([{ productId: 'v1', codes: ['A', 'B', 'C'] }]);
    });
    it('propagates service validation errors as 422 (需求 12.2)', async () => {
        h.cdkService.error = new HttpError(ErrorCode.Validation, 'no codes');
        const res = await request(h.app)
            .post('/admin/products/v1/cdks')
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
            .send({ codes: [] });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe(codeOf(ErrorCode.Validation));
    });
    it('propagates invalid-product errors as 422 for non-virtual/missing products (需求 12.6)', async () => {
        h.cdkService.error = new HttpError(ErrorCode.InvalidProductField, 'not virtual');
        const res = await request(h.app)
            .post('/admin/products/phys/cdks')
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
            .send({ codes: ['A'] });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe(codeOf(ErrorCode.InvalidProductField));
    });
});
