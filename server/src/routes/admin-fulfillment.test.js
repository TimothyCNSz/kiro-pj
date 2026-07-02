import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAdminFulfillmentRouter, SHIP_PHYSICAL_OK_MESSAGE, SHIP_VIRTUAL_OK_MESSAGE, ORDER_NOT_FOUND_MESSAGE, } from './admin-fulfillment';
import { createAuthMiddleware } from '../middleware/auth';
import { errorHandler, notFoundHandler, NOT_FOUND_CODE } from '../middleware/error-handler';
import { HttpError } from '../middleware/http-error';
import { SUCCESS_CODE } from '../lib/api';
import { Role, OrderStatus } from '../lib/domain';
import { ErrorCode, ERROR_DEFINITIONS } from '../lib/errors';
// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------
class FakeFulfillmentService {
    physicalCalls = [];
    virtualCalls = [];
    physicalResult = {
        orderId: 'phys-1',
        status: OrderStatus.Shipped,
        trackingNo: 'SF123',
        tracking: { trackingNo: 'SF123', carrier: 'demo', nodes: [{ status: 's', description: 'd' }] },
    };
    virtualResult = {
        orderId: 'virt-1',
        status: OrderStatus.Shipped,
        cdks: ['CDK-A'],
    };
    physicalError = null;
    virtualError = null;
    async shipPhysical(adminId, orderId, trackingNo) {
        this.physicalCalls.push({ adminId, orderId, trackingNo });
        if (this.physicalError)
            throw this.physicalError;
        return this.physicalResult;
    }
    async shipVirtual(adminId, orderId) {
        this.virtualCalls.push({ adminId, orderId });
        if (this.virtualError)
            throw this.virtualError;
        return this.virtualResult;
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
    const service = new FakeFulfillmentService();
    const authMiddleware = createAuthMiddleware({
        verifier: new FakeVerifier({
            [ADMIN_TOKEN]: { sub: 'admin-1', sid: 'sid-admin', role: Role.Admin },
            [EMPLOYEE_TOKEN]: { sub: 'emp-1', sid: 'sid-emp', role: Role.Employee },
        }),
        sessionManager: new FakeSessionManager(new Set(['sid-admin', 'sid-emp'])),
    });
    const router = createAdminFulfillmentRouter({ fulfillmentService: service, authMiddleware });
    const app = express();
    app.use(express.json());
    app.use('/admin/orders', router);
    app.use(notFoundHandler);
    app.use(errorHandler);
    return { app, service };
}
const codeOf = (c) => ERROR_DEFINITIONS[c].appCode;
// ---------------------------------------------------------------------------
// POST /admin/orders/:id/ship-physical
// ---------------------------------------------------------------------------
describe('POST /admin/orders/:id/ship-physical', () => {
    let h;
    beforeEach(() => {
        h = buildHarness();
    });
    it('rejects unauthenticated requests with 401 (需求 20.1, 20.3)', async () => {
        const res = await request(h.app)
            .post('/admin/orders/phys-1/ship-physical')
            .send({ trackingNo: 'SF1' });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe(codeOf(ErrorCode.Unauthenticated));
        expect(h.service.physicalCalls).toEqual([]);
    });
    it('rejects non-admin (employee) requests with 403 (需求 3.3, 20.4)', async () => {
        const res = await request(h.app)
            .post('/admin/orders/phys-1/ship-physical')
            .set('Authorization', `Bearer ${EMPLOYEE_TOKEN}`)
            .send({ trackingNo: 'SF1' });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe(codeOf(ErrorCode.Forbidden));
        expect(h.service.physicalCalls).toEqual([]);
    });
    it('ships physical order for an admin and returns success envelope (需求 8.2, 14.1)', async () => {
        const res = await request(h.app)
            .post('/admin/orders/phys-1/ship-physical')
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
            .send({ trackingNo: 'SF123' });
        expect(res.status).toBe(200);
        expect(res.body.code).toBe(SUCCESS_CODE);
        expect(res.body.message).toBe(SHIP_PHYSICAL_OK_MESSAGE);
        expect(res.body.data.status).toBe(OrderStatus.Shipped);
        expect(res.body.data.trackingNo).toBe('SF123');
        // actor id from JWT, order id from path, tracking from body
        expect(h.service.physicalCalls).toEqual([
            { adminId: 'admin-1', orderId: 'phys-1', trackingNo: 'SF123' },
        ]);
    });
    it('propagates TRACKING_REQUIRED as 422 for empty tracking number (需求 14.3)', async () => {
        h.service.physicalError = new HttpError(ErrorCode.TrackingRequired, 'empty');
        const res = await request(h.app)
            .post('/admin/orders/phys-1/ship-physical')
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
            .send({ trackingNo: '' });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe(codeOf(ErrorCode.TrackingRequired));
    });
    it('returns 404 when the order does not exist', async () => {
        h.service.physicalResult = null;
        const res = await request(h.app)
            .post('/admin/orders/missing/ship-physical')
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
            .send({ trackingNo: 'SF1' });
        expect(res.status).toBe(404);
        expect(res.body.code).toBe(NOT_FOUND_CODE);
        expect(res.body.message).toBe(ORDER_NOT_FOUND_MESSAGE);
    });
});
// ---------------------------------------------------------------------------
// POST /admin/orders/:id/ship-virtual
// ---------------------------------------------------------------------------
describe('POST /admin/orders/:id/ship-virtual', () => {
    let h;
    beforeEach(() => {
        h = buildHarness();
    });
    it('rejects unauthenticated requests with 401 (需求 20.1, 20.3)', async () => {
        const res = await request(h.app).post('/admin/orders/virt-1/ship-virtual').send();
        expect(res.status).toBe(401);
        expect(res.body.code).toBe(codeOf(ErrorCode.Unauthenticated));
        expect(h.service.virtualCalls).toEqual([]);
    });
    it('rejects non-admin (employee) requests with 403 (需求 3.3, 20.4)', async () => {
        const res = await request(h.app)
            .post('/admin/orders/virt-1/ship-virtual')
            .set('Authorization', `Bearer ${EMPLOYEE_TOKEN}`)
            .send();
        expect(res.status).toBe(403);
        expect(res.body.code).toBe(codeOf(ErrorCode.Forbidden));
        expect(h.service.virtualCalls).toEqual([]);
    });
    it('ships virtual order for an admin and returns CDKs (需求 9.4, 14.2)', async () => {
        const res = await request(h.app)
            .post('/admin/orders/virt-1/ship-virtual')
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
            .send();
        expect(res.status).toBe(200);
        expect(res.body.code).toBe(SUCCESS_CODE);
        expect(res.body.message).toBe(SHIP_VIRTUAL_OK_MESSAGE);
        expect(res.body.data.status).toBe(OrderStatus.Shipped);
        expect(res.body.data.cdks).toEqual(['CDK-A']);
        expect(h.service.virtualCalls).toEqual([{ adminId: 'admin-1', orderId: 'virt-1' }]);
    });
    it('propagates VALIDATION (type mismatch) as 422', async () => {
        h.service.virtualError = new HttpError(ErrorCode.Validation, 'not virtual');
        const res = await request(h.app)
            .post('/admin/orders/phys-1/ship-virtual')
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
            .send();
        expect(res.status).toBe(422);
        expect(res.body.code).toBe(codeOf(ErrorCode.Validation));
    });
    it('returns 404 when the order does not exist', async () => {
        h.service.virtualResult = null;
        const res = await request(h.app)
            .post('/admin/orders/missing/ship-virtual')
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
            .send();
        expect(res.status).toBe(404);
        expect(res.body.code).toBe(NOT_FOUND_CODE);
        expect(res.body.message).toBe(ORDER_NOT_FOUND_MESSAGE);
    });
});
