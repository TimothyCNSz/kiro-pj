import { describe, it, expect } from 'vitest';
import { success, paginated, failure, isSuccess, SUCCESS_CODE, } from './api';
import { ErrorCode, ERROR_DEFINITIONS } from './errors';
describe('api response contract', () => {
    it('success() wraps data with code 0 and default message', () => {
        const res = success({ id: 'u1' });
        expect(res).toEqual({ code: 0, message: 'ok', data: { id: 'u1' } });
        expect(isSuccess(res)).toBe(true);
    });
    it('success() honors a custom message', () => {
        expect(success(null, '注册成功').message).toBe('注册成功');
    });
    it('paginated() carries list plus pagination metadata', () => {
        const res = paginated(['a', 'b'], { page: 2, pageSize: 10, total: 42 });
        expect(res.code).toBe(SUCCESS_CODE);
        expect(res.data).toEqual({ list: ['a', 'b'], total: 42, page: 2, pageSize: 10 });
    });
    it('failure() maps an error code to its numeric appCode and string message', () => {
        const res = failure(ErrorCode.EmailTaken);
        expect(res.code).toBe(ERROR_DEFINITIONS[ErrorCode.EmailTaken].appCode);
        expect(res.code).not.toBe(SUCCESS_CODE);
        expect(res.message).toBe('EMAIL_TAKEN');
        expect(res.data).toBeNull();
        expect(isSuccess(res)).toBe(false);
    });
    it('failure() allows a localized override message', () => {
        const res = failure(ErrorCode.InsufficientPoints, '积分不足');
        expect(res.message).toBe('积分不足');
    });
    it('conforms to the frontend ApiResponse shape', () => {
        const res = success(1);
        expect(Object.keys(res).sort()).toEqual(['code', 'data', 'message']);
    });
});
