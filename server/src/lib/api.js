// Unified API response contract for AWSomeShop.
//
// These shapes are kept byte-for-byte compatible with the frontend contract in
// `src/types/index.ts` and the axios client in `src/api/http.ts` (which returns
// `response.data`, i.e. the `ApiResponse<T>` envelope). Backend handlers should
// always return one of these envelopes.
//
// Convention: `code` 0 means success; any non-zero `code` denotes an error and
// pairs with a localizable `message` (需求 17). Error `code` values come from
// the error registry in `./errors` (`ErrorDefinition.appCode`).
//
// Requirements: 17.2 (i18n-mappable messages), 19.3 (persistence via backend API).
import { ERROR_DEFINITIONS } from './errors';
/** 成功响应的数字码。 */
export const SUCCESS_CODE = 0;
/** 构造成功响应（`code = 0`）。 */
export function success(data, message = 'ok') {
    return { code: SUCCESS_CODE, message, data };
}
/**
 * 构造分页成功响应。
 * `list` 之外的分页元数据（total/page/pageSize）随 data 一并返回。
 */
export function paginated(list, meta, message = 'ok') {
    return success({ list, total: meta.total, page: meta.page, pageSize: meta.pageSize }, message);
}
/**
 * 构造错误响应。`code` 取错误码注册表中的数字 `appCode`（非零），
 * `message` 默认为字符串错误码标识，供前端映射到 i18n 文案。
 */
export function failure(code, message) {
    const def = ERROR_DEFINITIONS[code];
    return { code: def.appCode, message: message ?? code, data: null };
}
/** 判断响应是否为成功（`code === 0`）。 */
export const isSuccess = (res) => res.code === SUCCESS_CODE;
