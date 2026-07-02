import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createUploadsRouter } from './uploads';
import { createAuthMiddleware } from '../middleware/auth';
import { errorHandler, notFoundHandler } from '../middleware/error-handler';
import { SUCCESS_CODE } from '../lib/api';
import { Role } from '../lib/domain';
import { ErrorCode, ERROR_DEFINITIONS } from '../lib/errors';
import { HttpError } from '../middleware/http-error';
// ---------------------------------------------------------------------------
// Fakes — in-memory upload service records calls / returns a canned result;
// auth stubbed with deterministic verifier + session manager (no real DB/AWS).
// ---------------------------------------------------------------------------
const sampleResult = {
    uploadUrl: 'https://s3.example.com/products/p1/uuid.png?sig=x',
    objectKey: 'products/p1/uuid.png',
    publicUrl: 'https://cdn.example.com/media/products/p1/uuid.png',
};
class FakeUploadService {
    result = sampleResult;
    nextError = null;
    calls = [];
    async presign(actor, req) {
        this.calls.push({ actor, req });
        if (this.nextError) {
            const err = this.nextError;
            this.nextError = null;
            throw err;
        }
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
            userId: 'emp-1',
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
const EMP_PAYLOAD = { sub: 'emp-1', sid: 'sid-emp', role: Role.Employee };
function buildHarness() {
    const upload = new FakeUploadService();
    const authMiddleware = createAuthMiddleware({
        verifier: new FakeVerifier({ 'tok-emp': EMP_PAYLOAD }),
        sessionManager: new FakeSessionManager(new Set(['sid-emp'])),
    });
    const router = createUploadsRouter({ uploadService: upload, authMiddleware });
    const app = express();
    app.use(express.json());
    app.use('/uploads', router);
    app.use(notFoundHandler);
    app.use(errorHandler);
    return { app, upload };
}
const auth = (r) => r.set('Authorization', 'Bearer tok-emp');
const codeOf = (c) => ERROR_DEFINITIONS[c].appCode;
// ---------------------------------------------------------------------------
// Authentication (需求 1.15)
// ---------------------------------------------------------------------------
describe('POST /uploads/presign requires authentication (需求 1.15)', () => {
    let h;
    beforeEach(() => {
        h = buildHarness();
    });
    it('rejects without a token', async () => {
        const res = await request(h.app)
            .post('/uploads/presign')
            .send({ purpose: 'avatar', targetId: 'emp-1', contentType: 'image/png', size: 100 });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe(codeOf(ErrorCode.Unauthenticated));
        expect(h.upload.calls).toEqual([]);
    });
});
// ---------------------------------------------------------------------------
// Happy path — delegates and returns unified envelope
// ---------------------------------------------------------------------------
describe('POST /uploads/presign', () => {
    let h;
    beforeEach(() => {
        h = buildHarness();
    });
    it('forwards actor + request to the service and returns the presign envelope', async () => {
        const res = await auth(request(h.app).post('/uploads/presign')).send({
            purpose: 'avatar',
            targetId: 'emp-1',
            contentType: 'image/png',
            size: 100,
        });
        expect(res.status).toBe(200);
        expect(res.body.code).toBe(SUCCESS_CODE);
        expect(res.body.data).toEqual(sampleResult);
        expect(h.upload.calls).toEqual([
            {
                actor: { userId: 'emp-1', role: Role.Employee },
                req: { purpose: 'avatar', targetId: 'emp-1', contentType: 'image/png', size: 100 },
            },
        ]);
    });
    it('maps FORBIDDEN from the service to 403', async () => {
        h.upload.nextError = new HttpError(ErrorCode.Forbidden, '无权限上传该图片');
        const res = await auth(request(h.app).post('/uploads/presign')).send({
            purpose: 'product',
            targetId: 'p1',
            contentType: 'image/png',
            size: 100,
        });
        expect(res.status).toBe(ERROR_DEFINITIONS[ErrorCode.Forbidden].httpStatus);
        expect(res.body.code).toBe(codeOf(ErrorCode.Forbidden));
    });
    it('maps UNSUPPORTED_IMAGE_TYPE from the service to 422', async () => {
        h.upload.nextError = new HttpError(ErrorCode.UnsupportedImageType, '仅支持 JPG、PNG、WebP 格式的图片');
        const res = await auth(request(h.app).post('/uploads/presign')).send({
            purpose: 'avatar',
            targetId: 'emp-1',
            contentType: 'image/gif',
            size: 100,
        });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe(codeOf(ErrorCode.UnsupportedImageType));
    });
    it('maps IMAGE_TOO_LARGE from the service to 422', async () => {
        h.upload.nextError = new HttpError(ErrorCode.ImageTooLarge, '单张图片大小不得超过 5MB');
        const res = await auth(request(h.app).post('/uploads/presign')).send({
            purpose: 'avatar',
            targetId: 'emp-1',
            contentType: 'image/png',
            size: 99_999_999,
        });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe(codeOf(ErrorCode.ImageTooLarge));
    });
    const badBodies = [
        ['missing purpose', { targetId: 'emp-1', contentType: 'image/png', size: 100 }],
        ['invalid purpose', { purpose: 'banner', targetId: 'emp-1', contentType: 'image/png', size: 100 }],
        ['missing targetId', { purpose: 'avatar', contentType: 'image/png', size: 100 }],
        ['missing contentType', { purpose: 'avatar', targetId: 'emp-1', size: 100 }],
        ['non-numeric size', { purpose: 'avatar', targetId: 'emp-1', contentType: 'image/png', size: 'big' }],
    ];
    it.each(badBodies)('rejects %s with VALIDATION (422) before hitting the service', async (_label, body) => {
        const res = await auth(request(h.app).post('/uploads/presign')).send(body);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe(codeOf(ErrorCode.Validation));
        expect(h.upload.calls).toEqual([]);
    });
});
