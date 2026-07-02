import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createMeAvatarRouter } from './me-avatar';
import { createAuthMiddleware } from '../middleware/auth';
import { errorHandler, notFoundHandler } from '../middleware/error-handler';
import { SUCCESS_CODE } from '../lib/api';
import { Role } from '../lib/domain';
import { ErrorCode, ERROR_DEFINITIONS } from '../lib/errors';
import { HttpError } from '../middleware/http-error';
// ---------------------------------------------------------------------------
// Fakes — an in-memory avatar service records calls and returns a canned URL;
// auth is stubbed with a deterministic verifier + session manager (no real DB).
// ---------------------------------------------------------------------------
class FakeAvatarService {
    avatarUrl = 'https://cdn.example.com/media/avatars/user-1/abc.png';
    nextError = null;
    setCalls = [];
    async setAvatar(userId, objectKey) {
        this.setCalls.push({ userId, objectKey });
        if (this.nextError) {
            const err = this.nextError;
            this.nextError = null;
            throw err;
        }
        return { avatarUrl: this.avatarUrl };
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
    const avatar = new FakeAvatarService();
    const authMiddleware = createAuthMiddleware({
        verifier: new FakeVerifier({ 'tok-ok': PAYLOAD }),
        sessionManager: new FakeSessionManager(new Set(['sid-ok'])),
    });
    const router = createMeAvatarRouter({ avatarService: avatar, authMiddleware });
    const app = express();
    app.use(express.json());
    app.use('/me', router);
    app.use(notFoundHandler);
    app.use(errorHandler);
    return { app, avatar };
}
const auth = (r) => r.set('Authorization', 'Bearer tok-ok');
const codeOf = (c) => ERROR_DEFINITIONS[c].appCode;
// ---------------------------------------------------------------------------
// Authentication (需求 1.15, 23.3)
// ---------------------------------------------------------------------------
describe('POST /me/avatar requires authentication (需求 1.15, 23.3)', () => {
    let h;
    beforeEach(() => {
        h = buildHarness();
    });
    it('rejects the request without a token', async () => {
        const res = await request(h.app).post('/me/avatar').send({ objectKey: 'avatars/user-1/a.png' });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe(codeOf(ErrorCode.Unauthenticated));
        expect(h.avatar.setCalls).toEqual([]);
    });
});
// ---------------------------------------------------------------------------
// POST /me/avatar (需求 22.9, 23.3, 23.4)
// ---------------------------------------------------------------------------
describe('POST /me/avatar', () => {
    let h;
    beforeEach(() => {
        h = buildHarness();
    });
    it('associates the object to the CURRENT user and returns the new avatarUrl (需求 22.9, 23.4)', async () => {
        const res = await auth(request(h.app).post('/me/avatar')).send({
            objectKey: 'avatars/user-1/a.png',
        });
        expect(res.status).toBe(200);
        expect(res.body.code).toBe(SUCCESS_CODE);
        expect(res.body.data).toEqual({ avatarUrl: h.avatar.avatarUrl });
        // Self-only: userId comes from the token, never from the request body.
        expect(h.avatar.setCalls).toEqual([{ userId: 'user-1', objectKey: 'avatars/user-1/a.png' }]);
    });
    it('ignores any userId supplied in the body and uses the authenticated user (限本人)', async () => {
        await auth(request(h.app).post('/me/avatar')).send({
            objectKey: 'avatars/user-1/a.png',
            userId: 'someone-else',
        });
        expect(h.avatar.setCalls[0].userId).toBe('user-1');
    });
    it('rejects a missing objectKey with VALIDATION (422)', async () => {
        const res = await auth(request(h.app).post('/me/avatar')).send({});
        expect(res.status).toBe(422);
        expect(res.body.code).toBe(codeOf(ErrorCode.Validation));
        expect(h.avatar.setCalls).toEqual([]);
    });
    it('rejects a blank objectKey with VALIDATION (422)', async () => {
        const res = await auth(request(h.app).post('/me/avatar')).send({ objectKey: '   ' });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe(codeOf(ErrorCode.Validation));
    });
    it('maps service errors to their HTTP status', async () => {
        h.avatar.nextError = new HttpError(ErrorCode.Forbidden, '无权限访问该资源');
        const res = await auth(request(h.app).post('/me/avatar')).send({
            objectKey: 'avatars/user-1/a.png',
        });
        expect(res.status).toBe(ERROR_DEFINITIONS[ErrorCode.Forbidden].httpStatus);
        expect(res.body.code).toBe(codeOf(ErrorCode.Forbidden));
    });
});
