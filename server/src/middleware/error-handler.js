// Unified response / error-serialization middleware.
//
// Every response leaving the backend is an `ApiResponse` envelope. Domain
// errors are thrown as `HttpError` (carrying an `ErrorCode`) and mapped here to
// their HTTP status (via `ERROR_DEFINITIONS`) plus a `failure()` body. Unknown
// routes and unexpected errors fall back to generic envelopes so the frontend
// always receives a well-formed `{ code, message, data }` shape.
//
// Requirements: 19.3 (unified backend responses; ErrorCode -> HTTP + ApiResponse).
import { failure } from '../lib/api';
import { ERROR_DEFINITIONS } from '../lib/errors';
import { resolveErrorCode } from './http-error';
/**
 * Generic transport codes for conditions with no domain `ErrorCode`.
 * Kept distinct from the domain error registry (`appCode` 1001–1017) and from
 * the success code (0).
 */
export const NOT_FOUND_CODE = 1404;
export const INTERNAL_ERROR_CODE = 1500;
const genericFailure = (code, message) => ({
    code,
    message,
    data: null,
});
/** 未匹配任何路由时返回 404 与统一错误信封。 */
export const notFoundHandler = (_req, res) => {
    res.status(404).json(genericFailure(NOT_FOUND_CODE, 'NOT_FOUND'));
};
/**
 * 统一错误处理中间件（必须为四参签名，Express 才识别为错误处理器）。
 * - `HttpError` / 带合法 `errorCode` 的错误 -> 映射为对应 HTTP 状态 + `failure()`。
 * - 其余未预期错误 -> 500 + 通用错误信封。
 */
export const errorHandler = (err, _req, res, _next) => {
    const code = resolveErrorCode(err);
    if (code) {
        const def = ERROR_DEFINITIONS[code];
        const message = err instanceof Error ? err.message : undefined;
        res.status(def.httpStatus).json(failure(code, message));
        return;
    }
    res.status(500).json(genericFailure(INTERNAL_ERROR_CODE, 'INTERNAL_ERROR'));
};
