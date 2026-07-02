import { describe, it, expect, beforeEach } from 'vitest';
import { ProductImageService, resolveMaxProductImages, DEFAULT_MAX_PRODUCT_IMAGES, } from './product-image-service';
import { ErrorCode } from '../lib/errors';
import { HttpError } from '../middleware/http-error';
// ---------------------------------------------------------------------------
// In-memory fake gateway (no real DB). Mirrors the partial-unique-index and
// ordering semantics the service relies on.
// ---------------------------------------------------------------------------
class FakeProductImageGateway {
    rows = [];
    seq = 0;
    clock = 0;
    seed(rows) {
        for (const r of rows)
            this.push(r);
    }
    push(r) {
        const row = {
            id: r.id ?? `img-${++this.seq}`,
            productId: r.productId,
            objectKey: r.objectKey ?? `obj-${this.seq}`,
            url: r.url ?? `https://cdn/${this.seq}`,
            isPrimary: r.isPrimary ?? false,
            sortOrder: r.sortOrder ?? 0,
            createdAt: r.createdAt ?? new Date(this.clock++),
        };
        this.rows.push(row);
        return row;
    }
    async count(productId) {
        return this.rows.filter((r) => r.productId === productId).length;
    }
    async insert(row) {
        return this.push({
            productId: row.productId,
            objectKey: row.objectKey,
            url: row.url,
            isPrimary: row.isPrimary ?? false,
            sortOrder: row.sortOrder ?? 0,
        });
    }
    async findById(productId, imageId) {
        return this.rows.find((r) => r.productId === productId && r.id === imageId) ?? null;
    }
    async list(productId) {
        return this.rows
            .filter((r) => r.productId === productId)
            .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime());
    }
    async clearPrimary(productId) {
        for (const r of this.rows)
            if (r.productId === productId)
                r.isPrimary = false;
    }
    async markPrimary(productId, imageId) {
        for (const r of this.rows) {
            if (r.productId === productId && r.id === imageId)
                r.isPrimary = true;
        }
    }
    async remove(productId, imageId) {
        const before = this.rows.length;
        this.rows = this.rows.filter((r) => !(r.productId === productId && r.id === imageId));
        return this.rows.length < before;
    }
    /** Count of primaries for a product (invariant helper). */
    primaryCount(productId) {
        return this.rows.filter((r) => r.productId === productId && r.isPrimary).length;
    }
}
const PID = 'p1';
// ---------------------------------------------------------------------------
// resolveMaxProductImages
// ---------------------------------------------------------------------------
describe('resolveMaxProductImages', () => {
    it('parses a positive integer from the env value', () => {
        expect(resolveMaxProductImages('3')).toBe(3);
    });
    it('falls back to the default for missing / non-positive / non-integer values', () => {
        expect(resolveMaxProductImages(undefined)).toBe(DEFAULT_MAX_PRODUCT_IMAGES);
        expect(resolveMaxProductImages('0')).toBe(DEFAULT_MAX_PRODUCT_IMAGES);
        expect(resolveMaxProductImages('-2')).toBe(DEFAULT_MAX_PRODUCT_IMAGES);
        expect(resolveMaxProductImages('abc')).toBe(DEFAULT_MAX_PRODUCT_IMAGES);
        expect(resolveMaxProductImages('2.5')).toBe(DEFAULT_MAX_PRODUCT_IMAGES);
    });
});
// ---------------------------------------------------------------------------
// addImage — 上限校验 + 首图自动主图（需求 12.9, 22.11, 22.12）
// ---------------------------------------------------------------------------
describe('ProductImageService.addImage', () => {
    let gateway;
    let service;
    beforeEach(() => {
        gateway = new FakeProductImageGateway();
        service = new ProductImageService({ gateway, maxImages: 5 });
    });
    it('auto-marks the first image as primary (需求 12.9)', async () => {
        const img = await service.addImage(PID, 'k1', 'https://cdn/1');
        expect(img.isPrimary).toBe(true);
        expect(img.sortOrder).toBe(0);
        expect(gateway.primaryCount(PID)).toBe(1);
    });
    it('appends subsequent images as non-primary with increasing sortOrder', async () => {
        await service.addImage(PID, 'k1', 'u1');
        const second = await service.addImage(PID, 'k2', 'u2');
        const third = await service.addImage(PID, 'k3', 'u3');
        expect(second.isPrimary).toBe(false);
        expect(second.sortOrder).toBe(1);
        expect(third.sortOrder).toBe(2);
        expect(gateway.primaryCount(PID)).toBe(1);
    });
    it('rejects adding beyond the limit with IMAGE_LIMIT_EXCEEDED and leaves existing images intact (需求 22.11, 22.12)', async () => {
        for (let i = 0; i < 5; i++)
            await service.addImage(PID, `k${i}`, `u${i}`);
        await expect(service.addImage(PID, 'k5', 'u5')).rejects.toMatchObject({
            errorCode: ErrorCode.ImageLimitExceeded,
        });
        await expect(service.addImage(PID, 'k5', 'u5')).rejects.toBeInstanceOf(HttpError);
        // rejected add did not insert anything: still exactly 5 images.
        expect(await gateway.count(PID)).toBe(5);
    });
    it('honors a custom maxImages limit', async () => {
        const svc = new ProductImageService({ gateway, maxImages: 2 });
        await svc.addImage(PID, 'k1', 'u1');
        await svc.addImage(PID, 'k2', 'u2');
        await expect(svc.addImage(PID, 'k3', 'u3')).rejects.toMatchObject({
            errorCode: ErrorCode.ImageLimitExceeded,
        });
    });
});
// ---------------------------------------------------------------------------
// setPrimary — 原主图降级（需求 12.8）
// ---------------------------------------------------------------------------
describe('ProductImageService.setPrimary', () => {
    let gateway;
    let service;
    beforeEach(() => {
        gateway = new FakeProductImageGateway();
        service = new ProductImageService({ gateway, maxImages: 5 });
    });
    it('promotes the target and demotes the previous primary (需求 12.8)', async () => {
        const a = await service.addImage(PID, 'k1', 'u1'); // primary
        const b = await service.addImage(PID, 'k2', 'u2');
        const ok = await service.setPrimary(PID, b.id);
        expect(ok).toBe(true);
        const gallery = await service.listImages(PID);
        expect(gallery.primary?.id).toBe(b.id);
        expect(gateway.primaryCount(PID)).toBe(1);
        // previous primary demoted
        const reloadedA = await gateway.findById(PID, a.id);
        expect(reloadedA?.isPrimary).toBe(false);
    });
    it('returns false for a non-existent image and changes nothing', async () => {
        await service.addImage(PID, 'k1', 'u1');
        const ok = await service.setPrimary(PID, 'missing');
        expect(ok).toBe(false);
        expect(gateway.primaryCount(PID)).toBe(1);
    });
});
// ---------------------------------------------------------------------------
// removeImage — 删除主图后自动补选（需求 12.9）
// ---------------------------------------------------------------------------
describe('ProductImageService.removeImage', () => {
    let gateway;
    let service;
    beforeEach(() => {
        gateway = new FakeProductImageGateway();
        service = new ProductImageService({ gateway, maxImages: 5 });
    });
    it('removing a non-primary image keeps the same primary', async () => {
        const a = await service.addImage(PID, 'k1', 'u1'); // primary
        const b = await service.addImage(PID, 'k2', 'u2');
        expect(await service.removeImage(PID, b.id)).toBe(true);
        const gallery = await service.listImages(PID);
        expect(gallery.primary?.id).toBe(a.id);
        expect(gallery.images).toHaveLength(1);
    });
    it('removing the primary auto-promotes the smallest sortOrder remaining image (需求 12.9)', async () => {
        const a = await service.addImage(PID, 'k1', 'u1'); // primary, sortOrder 0
        const b = await service.addImage(PID, 'k2', 'u2'); // sortOrder 1
        await service.addImage(PID, 'k3', 'u3'); // sortOrder 2
        expect(await service.removeImage(PID, a.id)).toBe(true);
        const gallery = await service.listImages(PID);
        expect(gallery.primary?.id).toBe(b.id);
        expect(gateway.primaryCount(PID)).toBe(1);
    });
    it('removing the last image leaves an empty gallery with no primary', async () => {
        const a = await service.addImage(PID, 'k1', 'u1');
        expect(await service.removeImage(PID, a.id)).toBe(true);
        const gallery = await service.listImages(PID);
        expect(gallery.images).toHaveLength(0);
        expect(gallery.primary).toBeNull();
    });
    it('returns false for a non-existent image', async () => {
        expect(await service.removeImage(PID, 'missing')).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// listImages — 非空图集恒返回恰一张主图（需求 12.9）
// ---------------------------------------------------------------------------
describe('ProductImageService.listImages', () => {
    let gateway;
    let service;
    beforeEach(() => {
        gateway = new FakeProductImageGateway();
        service = new ProductImageService({ gateway, maxImages: 5 });
    });
    it('returns null primary and empty list for a product with no images', async () => {
        const gallery = await service.listImages(PID);
        expect(gallery).toEqual({ primary: null, images: [] });
    });
    it('auto-picks the smallest sortOrder as primary when none is marked, and persists it (需求 12.9)', async () => {
        // seed a legacy/degenerate gallery with NO primary flag
        gateway.seed([
            { productId: PID, sortOrder: 2, isPrimary: false },
            { productId: PID, sortOrder: 0, isPrimary: false },
            { productId: PID, sortOrder: 1, isPrimary: false },
        ]);
        const gallery = await service.listImages(PID);
        expect(gallery.images).toHaveLength(3);
        expect(gallery.primary).not.toBeNull();
        expect(gallery.primary?.sortOrder).toBe(0);
        // exactly one primary, both in the view and persisted
        expect(gallery.images.filter((i) => i.isPrimary)).toHaveLength(1);
        expect(gateway.primaryCount(PID)).toBe(1);
    });
    it('returns the marked primary as-is when present', async () => {
        gateway.seed([
            { productId: PID, id: 'x', sortOrder: 0, isPrimary: false },
            { productId: PID, id: 'y', sortOrder: 1, isPrimary: true },
        ]);
        const gallery = await service.listImages(PID);
        expect(gallery.primary?.id).toBe('y');
        expect(gateway.primaryCount(PID)).toBe(1);
    });
    it('returns images ordered by sortOrder ascending', async () => {
        await service.addImage(PID, 'k1', 'u1');
        await service.addImage(PID, 'k2', 'u2');
        await service.addImage(PID, 'k3', 'u3');
        const gallery = await service.listImages(PID);
        expect(gallery.images.map((i) => i.sortOrder)).toEqual([0, 1, 2]);
    });
});
