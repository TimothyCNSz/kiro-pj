import { describe, it, expect } from 'vitest';
import { CdkService, normalizeCdkCodes } from './cdk-service';
import { ProductType } from '../lib/domain';
import { ErrorCode } from '../lib/errors';
import { HttpError } from '../middleware/http-error';
// ---------------------------------------------------------------------------
// Fake gateway (in-memory, no real DB)
// ---------------------------------------------------------------------------
class FakeCdkGateway {
    /** productId -> product type (null-able via absence). */
    types;
    /** productId -> inserted available codes. */
    inserted = {};
    constructor(types = {}) {
        this.types = types;
    }
    async getProductType(productId) {
        return this.types[productId] ?? null;
    }
    async insertCdks(productId, codes) {
        this.inserted[productId] = [...(this.inserted[productId] ?? []), ...codes];
    }
    async countAvailable(productId) {
        return (this.inserted[productId] ?? []).length;
    }
}
const virtualGateway = () => new FakeCdkGateway({ v1: ProductType.Virtual });
// ---------------------------------------------------------------------------
// normalizeCdkCodes
// ---------------------------------------------------------------------------
describe('normalizeCdkCodes', () => {
    it('trims whitespace and drops empty entries', () => {
        expect(normalizeCdkCodes(['  A ', 'B', '   ', ''])).toEqual(['A', 'B']);
    });
    it('ignores non-string entries', () => {
        expect(normalizeCdkCodes(['A', 1, null, undefined, {}, 'B'])).toEqual(['A', 'B']);
    });
    it('returns an empty array for non-array input', () => {
        expect(normalizeCdkCodes('A')).toEqual([]);
        expect(normalizeCdkCodes(undefined)).toEqual([]);
    });
});
// ---------------------------------------------------------------------------
// CdkService.addCdks
// ---------------------------------------------------------------------------
describe('CdkService.addCdks', () => {
    it('adds CDKs to a virtual product and reports the updated available stock (需求 12.2, 5.1)', async () => {
        const gateway = virtualGateway();
        const service = new CdkService({ gateway });
        const result = await service.addCdks('v1', ['CDK-1', 'CDK-2', 'CDK-3']);
        expect(result).toEqual({ added: 3, availableStock: 3 });
        expect(gateway.inserted.v1).toEqual(['CDK-1', 'CDK-2', 'CDK-3']);
    });
    it('accumulates available stock across successive additions (需求 5.1)', async () => {
        const gateway = virtualGateway();
        const service = new CdkService({ gateway });
        await service.addCdks('v1', ['A']);
        const result = await service.addCdks('v1', ['B', 'C']);
        expect(result.added).toBe(2);
        expect(result.availableStock).toBe(3);
    });
    it('normalizes codes before insertion (trims / drops empty)', async () => {
        const gateway = virtualGateway();
        const service = new CdkService({ gateway });
        const result = await service.addCdks('v1', ['  X ', '', '   ', 'Y']);
        expect(result.added).toBe(2);
        expect(gateway.inserted.v1).toEqual(['X', 'Y']);
    });
    it('rejects an empty / whitespace-only code list with VALIDATION', async () => {
        const service = new CdkService({ gateway: virtualGateway() });
        await expect(service.addCdks('v1', ['   ', ''])).rejects.toMatchObject({
            errorCode: ErrorCode.Validation,
        });
        await expect(service.addCdks('v1', [])).rejects.toBeInstanceOf(HttpError);
    });
    it('rejects a non-existent product with INVALID_PRODUCT_FIELD', async () => {
        const service = new CdkService({ gateway: virtualGateway() });
        await expect(service.addCdks('missing', ['A'])).rejects.toMatchObject({
            errorCode: ErrorCode.InvalidProductField,
        });
    });
    it('rejects maintaining CDKs on a physical product with INVALID_PRODUCT_FIELD (需求 12.6)', async () => {
        const gateway = new FakeCdkGateway({ phys: ProductType.Physical });
        const service = new CdkService({ gateway });
        await expect(service.addCdks('phys', ['A'])).rejects.toMatchObject({
            errorCode: ErrorCode.InvalidProductField,
        });
        // no CDKs should have been inserted for a rejected physical product
        expect(gateway.inserted.phys).toBeUndefined();
    });
});
