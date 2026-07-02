import { describe, it, expect } from 'vitest';
import { Role, AccountStatus, ProductType, ProductStatus, OrderType, OrderStatus, isRole, isAccountStatus, isProductType, isProductStatus, isOrderType, isOrderStatus, } from './domain';
import { ErrorCode, ERROR_DEFINITIONS, ERROR_CODE_VALUES, errorDefinition, isErrorCode, } from './errors';
describe('domain enums', () => {
    it('expose the values defined in the design data model', () => {
        expect(Role.Employee).toBe('employee');
        expect(Role.Admin).toBe('admin');
        expect(AccountStatus.PendingVerification).toBe('pending_verification');
        expect(AccountStatus.Active).toBe('active');
        expect(ProductType.Physical).toBe('physical');
        expect(ProductType.Virtual).toBe('virtual');
        expect(ProductStatus.Listed).toBe('listed');
        expect(ProductStatus.Unlisted).toBe('unlisted');
        expect(OrderType.Physical).toBe('physical');
        expect(OrderType.Virtual).toBe('virtual');
        expect(OrderStatus.PendingShipment).toBe('pending_shipment');
        expect(OrderStatus.Shipped).toBe('shipped');
    });
    it('type guards accept valid members and reject others', () => {
        expect(isRole('employee')).toBe(true);
        expect(isRole('superuser')).toBe(false);
        expect(isAccountStatus('active')).toBe(true);
        expect(isAccountStatus('deleted')).toBe(false);
        expect(isProductType('virtual')).toBe(true);
        expect(isProductType('digital')).toBe(false);
        expect(isProductStatus('listed')).toBe(true);
        expect(isProductStatus('archived')).toBe(false);
        expect(isOrderType('physical')).toBe(true);
        expect(isOrderType('bundle')).toBe(false);
        expect(isOrderStatus('shipped')).toBe(true);
        expect(isOrderStatus('cancelled')).toBe(false);
    });
});
describe('error code registry', () => {
    it('has a definition for every error code', () => {
        for (const code of ERROR_CODE_VALUES) {
            expect(ERROR_DEFINITIONS[code].code).toBe(code);
            expect(errorDefinition(code)).toBe(ERROR_DEFINITIONS[code]);
        }
    });
    it('assigns unique non-zero appCodes and valid HTTP statuses', () => {
        const appCodes = ERROR_CODE_VALUES.map((c) => ERROR_DEFINITIONS[c].appCode);
        expect(new Set(appCodes).size).toBe(appCodes.length);
        expect(appCodes.every((n) => n !== 0)).toBe(true);
        expect(ERROR_CODE_VALUES.every((c) => {
            const s = ERROR_DEFINITIONS[c].httpStatus;
            return s >= 400 && s < 600;
        })).toBe(true);
    });
    it('matches key HTTP statuses from the design Error Handling table', () => {
        expect(ERROR_DEFINITIONS[ErrorCode.Unauthenticated].httpStatus).toBe(401);
        expect(ERROR_DEFINITIONS[ErrorCode.Forbidden].httpStatus).toBe(403);
        expect(ERROR_DEFINITIONS[ErrorCode.VerificationExpired].httpStatus).toBe(410);
        expect(ERROR_DEFINITIONS[ErrorCode.VerificationInvalid].httpStatus).toBe(400);
        expect(ERROR_DEFINITIONS[ErrorCode.ImageLimitExceeded].httpStatus).toBe(409);
    });
    it('isErrorCode guards membership', () => {
        expect(isErrorCode('EMAIL_TAKEN')).toBe(true);
        expect(isErrorCode('NOPE')).toBe(false);
    });
});
