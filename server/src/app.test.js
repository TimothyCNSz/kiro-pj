import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import fc from 'fast-check';
import { createApp, GLOBAL_PREFIX } from './app';
import { registerRoutes } from './routes';
import { errorHandler, notFoundHandler, NOT_FOUND_CODE, INTERNAL_ERROR_CODE } from './middleware/error-handler';
import { HttpError } from './middleware/http-error';
import { ERROR_CODE_VALUES, ERROR_DEFINITIONS, ErrorCode } from './lib/errors';
import { SUCCESS_CODE } from './lib/api';
// Builds an app with the standard middleware plus a helper route that throws a
// given HttpError, so we can assert the ErrorCode -> HTTP + ApiResponse mapping.
function appThrowing(code) {
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerRoutes(router);
    router.get('/boom', () => {
        throw new HttpError(code);
    });
    app.use(GLOBAL_PREFIX, router);
    app.use(notFoundHandler);
    app.use(errorHandler);
    return app;
}
describe('backend app skeleton', () => {
    it('serves the health route under the global /api prefix with a success envelope', async () => {
        const res = await request(createApp()).get(`${GLOBAL_PREFIX}/health`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            code: SUCCESS_CODE,
            message: 'ok',
            data: { service: 'awsome-shop', status: 'ok' },
        });
    });
    it('returns a unified 404 envelope for unknown routes', async () => {
        const res = await request(createApp()).get(`${GLOBAL_PREFIX}/does-not-exist`);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ code: NOT_FOUND_CODE, message: 'NOT_FOUND', data: null });
    });
    it('does not expose the x-powered-by header', async () => {
        const res = await request(createApp()).get(`${GLOBAL_PREFIX}/health`);
        expect(res.headers['x-powered-by']).toBeUndefined();
    });
    it('maps a thrown HttpError to its ErrorCode HTTP status + ApiResponse body', async () => {
        const res = await request(appThrowing(ErrorCode.Forbidden)).get(`${GLOBAL_PREFIX}/boom`);
        const def = ERROR_DEFINITIONS[ErrorCode.Forbidden];
        expect(res.status).toBe(def.httpStatus);
        expect(res.body).toEqual({ code: def.appCode, message: ErrorCode.Forbidden, data: null });
    });
    it('falls back to a generic 500 envelope for unexpected errors', async () => {
        const app = express();
        app.get(`${GLOBAL_PREFIX}/crash`, () => {
            throw new Error('unexpected');
        });
        app.use(notFoundHandler);
        app.use(errorHandler);
        const res = await request(app).get(`${GLOBAL_PREFIX}/crash`);
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ code: INTERNAL_ERROR_CODE, message: 'INTERNAL_ERROR', data: null });
    });
});
// Property: every domain ErrorCode serializes to its registered HTTP status and
// numeric appCode via the unified error middleware.
// Feature: awsome-shop — unified error serialization (Requirements 19.3)
describe('error serialization mapping', () => {
    it('maps any ErrorCode to its registered httpStatus and appCode', async () => {
        await fc.assert(fc.asyncProperty(fc.constantFrom(...ERROR_CODE_VALUES), async (code) => {
            const res = await request(appThrowing(code)).get(`${GLOBAL_PREFIX}/boom`);
            const def = ERROR_DEFINITIONS[code];
            return (res.status === def.httpStatus &&
                res.body.code === def.appCode &&
                res.body.message === code &&
                res.body.data === null);
        }), { numRuns: 100 });
    });
});
