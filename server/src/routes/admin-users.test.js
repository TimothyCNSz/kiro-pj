import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAdminUsersRouter, LIST_USERS_OK_MESSAGE, } from './admin-users';
import { createAuthMiddleware } from '../middleware/auth';
import { errorHandler, notFoundHandler } from '../middleware/error-handler';
import { SUCCESS_CODE } from '../lib/api';
import { AccountStatus, Role } from '../lib/domain';
import { ErrorCode, ERROR_DEFINITIONS } from '../lib/errors';
class FakeAdminUserService {
    calls = [];
    result = { list: [], total: 0, page: 1, pageSize: 20 };
    async listUsers(query) {
        this.calls.push(query);
        return { ...this.result, page: query.page, pageSize: query.pageSize };
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
    const adminUserService = new FakeAdminUserService();
    const authMiddleware = createAuthMiddleware({
        verifier: new FakeVerifier({
            [ADMIN_TOKEN]: { sub: 'admin-1', sid: 'sid-admin', role: Role.Admin },
            [EMPLOYEE_TOKEN]: { sub: 'emp-1', sid: 'sid-emp', role: Role.Employee },
        }),
        sessionManager: new FakeSessionManager(new Set(['sid-admin', 'sid-emp'])),
    });
    const router = createAdminUsersRouter({ adminUserService, authMiddleware });
    const app = express();
    app.use(express.json());
    app.use('/admin/users', router);
    app.use(notFoundHandler);
    app.use(errorHandler);
    return { app, adminUserService };
}
const codeOf = (c) => ERROR_DEFINITIONS[c].appCode;
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('GET /admin/users', () => {
    let h;
    beforeEach(() => {
        h = buildHarness();
    });
    it('rejects unauthenticated requests with 401 (需求 20.1, 20.3)', async () => {
        const res = await request(h.app).get('/admin/users');
        expect(res.status).toBe(401);
        expect(res.body.code).toBe(codeOf(ErrorCode.Unauthenticated));
        expect(h.adminUserService.calls).toHaveLength(0);
    });
    it('rejects non-admin (employee) requests with 403 (需求 24.6, 3.3, 20.4)', async () => {
        const res = await request(h.app)
            .get('/admin/users')
            .set('Authorization', `Bearer ${EMPLOYEE_TOKEN}`);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe(codeOf(ErrorCode.Forbidden));
        expect(h.adminUserService.calls).toHaveLength(0);
    });
    it('returns the paginated employee list for an admin (需求 24.1)', async () => {
        h.adminUserService.result = {
            list: [
                { userId: 'u1', email: 'alice@corp.com', role: Role.Employee, status: AccountStatus.Active, balance: 100 },
                {
                    userId: 'u2',
                    email: 'bob@corp.com',
                    role: Role.Employee,
                    status: AccountStatus.PendingVerification,
                    balance: 50,
                },
            ],
            total: 2,
            page: 1,
            pageSize: 20,
        };
        const res = await request(h.app)
            .get('/admin/users')
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.code).toBe(SUCCESS_CODE);
        expect(res.body.message).toBe(LIST_USERS_OK_MESSAGE);
        expect(res.body.data.list).toHaveLength(2);
        expect(res.body.data.list[0]).toEqual({
            userId: 'u1',
            email: 'alice@corp.com',
            role: Role.Employee,
            status: AccountStatus.Active,
            balance: 100,
        });
        expect(res.body.data.total).toBe(2);
    });
    it('forwards q and pagination query params to the service (需求 24.2, 24.4)', async () => {
        await request(h.app)
            .get('/admin/users')
            .query({ q: 'corp', page: '3', pageSize: '5' })
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
        expect(h.adminUserService.calls).toHaveLength(1);
        expect(h.adminUserService.calls[0]).toEqual({ q: 'corp', page: 3, pageSize: 5 });
    });
    it('returns an empty list envelope when no employee matches (需求 24.3 空状态)', async () => {
        h.adminUserService.result = { list: [], total: 0, page: 1, pageSize: 20 };
        const res = await request(h.app)
            .get('/admin/users')
            .query({ q: 'nobody' })
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.code).toBe(SUCCESS_CODE);
        expect(res.body.data.list).toEqual([]);
        expect(res.body.data.total).toBe(0);
    });
    it('defaults q to empty string and pagination when params are absent/invalid', async () => {
        await request(h.app)
            .get('/admin/users')
            .query({ page: '0' })
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
        expect(h.adminUserService.calls[0]).toEqual({ q: '', page: 1, pageSize: 20 });
    });
});
