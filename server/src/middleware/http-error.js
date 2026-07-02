// Framework-level error carrier for the backend.
//
// Service/route code throws `HttpError` with a domain `ErrorCode` (from
// `../lib/errors`); the unified error middleware (`./error-handler`) translates
// it into the correct HTTP status + `ApiResponse` envelope. This keeps handlers
// free of transport concerns — they only speak in domain error codes.
//
// Requirements: 19.3 (unified backend responses).
import { isErrorCode } from '../lib/errors';
/** 携带领域错误码的应用级错误，供统一错误中间件序列化。 */
export class HttpError extends Error {
    /** 领域错误码（映射到 HTTP 状态与 `ApiResponse.code`）。 */
    errorCode;
    constructor(errorCode, message) {
        super(message ?? errorCode);
        this.name = 'HttpError';
        this.errorCode = errorCode;
        // Restore prototype chain for `instanceof` under transpilation targets.
        Object.setPrototypeOf(this, HttpError.prototype);
    }
}
/** 便捷构造器：`throw httpError(ErrorCode.Forbidden)`。 */
export const httpError = (code, message) => new HttpError(code, message);
/**
 * 从任意抛出的值中解析领域错误码（若存在）。
 * 支持 `HttpError` 实例，或任何带合法 `errorCode` 字段的对象。
 */
export function resolveErrorCode(err) {
    if (err instanceof HttpError)
        return err.errorCode;
    if (typeof err === 'object' &&
        err !== null &&
        'errorCode' in err &&
        isErrorCode(err.errorCode)) {
        return err.errorCode;
    }
    return undefined;
}
