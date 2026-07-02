import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAdminAlertsRouter, LIST_LOW_STOCK_OK_MESSAGE, } from './admin-alerts';
import { createAuthMiddleware } from '../middleware/auth';
import { errorHandler, notFoundHandler } from '../middleware/error-handler';
import { SUCCESS_CODE } from '../lib/api';
import { Role } from '../lib/domain';
import { ErrorCode, ERROR_DEFINITIONS } from '../lib/errors';
// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------
class FakeAlertService {
    calls = 0;
    result = [];
    error = null;
    async listLowStock() {
        this.calls += 1;
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
    const alertService = new FakeAlertService();
    const authMiddleware = createAuthMiddleware({
        verifier: new FakeVerifier({
            [ADMIN_TOKEN]: { sub: 'admin-1', sid: 'sid-admin', role: Role.Admin },
            [EMPLOYEE_TOKEN]: { sub: 'emp-1', sid: 'sid-emp', role: Role.Employee },
        }),
        sessionManager: new FakeSessionManager(new Set(['sid-admin', 'sid-emp'])),
    });
    const router = createAdminAlertsRouter({ alertService, authMiddleware });
    const app = express();
    app.use(express.json());
    app.use('/admin/alerts', router);
    app.use(notFoundHandler);
    app.use(errorHandler);
    return { app, alertService };
}
const codeOf = (c) => ERROR_DEFINITIONS[c].appCode;
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('GET /admin/alerts/low-stock', () => {
    let h;
    beforeEach(() => {
        h = buildHarness();
    });
    it('rejects unauthenticated requests with 401 (需求 20.1, 20.3)', async () => {
        const res = await request(h.app).get('/admin/alerts/low-stock');
        expect(res.status).toBe(401);
        expect(res.body.code).toBe(codeOf(ErrorCode.Unauthenticated));
        expect(h.alertService.calls).toBe(0);
    });
    it('rejects non-admin (employee) requests with 403 (需求 3.3, 20.4)', async () => {
        const res = await request(h.app)
            .get('/admin/alerts/low-stock')
            .set('Authorization', `Bearer ${EMPLOYEE_TOKEN}`);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe(codeOf(ErrorCode.Forbidden));
        expect(h.alertService.calls).toBe(0);
    });
    it('returns the current low-stock alerts for an admin (需求 15.2)', async () => {
        h.alertService.result = [
            { id: 'a1', productId: 'p1', productName: '商品一', triggeredAt: new Date('2024-01-02T00:00:00Z') },
            { id: 'a2', productId: 'p2', productName: '商品二', triggeredAt: new Date('2024-01-01T00:00:00Z') },
        ];
        const res = await request(h.app)
            .get('/admin/alerts/low-stock')
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.code).toBe(SUCCESS_CODE);
        expect(res.body.message).toBe(LIST_LOW_STOCK_OK_MESSAGE);
        expect(res.body.data).toHaveLength(2);
        expect(res.body.data.map((a) => a.productId)).toEqual(['p1', 'p2']);
        expect(h.alertService.calls).toBe(1);
    });
    it('returns an empty list when there are no alerts', async () => {
        const res = await request(h.app)
            .get('/admin/alerts/low-stock')
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.code).toBe(SUCCESS_CODE);
        expect(res.body.data).toEqual([]);
    });
});
