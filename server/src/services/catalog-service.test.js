import { describe, it, expect } from 'vitest';
import { CatalogService, PLACEHOLDER_IMAGE_URL, } from './catalog-service';
import { ProductStatus, ProductType } from '../lib/domain';
// ---------------------------------------------------------------------------
// Builders + in-memory fake repository (no real database)
// ---------------------------------------------------------------------------
function makeProduct(overrides = {}) {
    return {
        id: overrides.id ?? 'p1',
        name: overrides.name ?? 'Widget',
        // Honor an explicit `null` (no-image case) rather than collapsing to the default.
        imageUrl: 'imageUrl' in overrides ? overrides.imageUrl : 'https://cdn/media/p1.jpg',
        description: overrides.description ?? 'A widget',
        pointsCost: overrides.pointsCost ?? 100,
        type: overrides.type ?? ProductType.Physical,
        status: overrides.status ?? ProductStatus.Listed,
        stock: overrides.stock ?? 5,
        version: overrides.version ?? 0,
        createdAt: overrides.createdAt ?? new Date('2024-01-01T00:00:00Z'),
    };
}
function makeImage(overrides = {}) {
    return {
        id: overrides.id ?? 'img1',
        productId: overrides.productId ?? 'p1',
        objectKey: overrides.objectKey ?? 'products/p1/img1.jpg',
        url: overrides.url ?? 'https://cdn/media/products/p1/img1.jpg',
        isPrimary: overrides.isPrimary ?? false,
        sortOrder: overrides.sortOrder ?? 0,
        createdAt: overrides.createdAt ?? new Date('2024-01-01T00:00:00Z'),
    };
}
/**
 * Fake repository whose list/search return ALL seeded rows unfiltered, so the
 * CatalogService's own defensive listed/name filtering (Property 8) is what is
 * under test — independent of any SQL.
 */
class FakeRepo {
    products;
    images;
    constructor(products = [], images = []) {
        this.products = products;
        this.images = images;
    }
    async listListed(_p) {
        return { rows: [...this.products], total: this.products.length };
    }
    async searchListedByName(_keyword, _p) {
        return { rows: [...this.products], total: this.products.length };
    }
    async findById(productId) {
        return this.products.find((p) => p.id === productId) ?? null;
    }
    async listImages(productId) {
        return this.images.filter((i) => i.productId === productId);
    }
}
const PAGINATION = { page: 1, pageSize: 20 };
// ---------------------------------------------------------------------------
// listProducts
// ---------------------------------------------------------------------------
describe('CatalogService.listProducts', () => {
    it('returns only listed products, excluding unlisted ones (需求 4.1, 4.2)', async () => {
        const repo = new FakeRepo([
            makeProduct({ id: 'a', status: ProductStatus.Listed }),
            makeProduct({ id: 'b', status: ProductStatus.Unlisted }),
            makeProduct({ id: 'c', status: ProductStatus.Listed }),
        ]);
        const service = new CatalogService({ repository: repo });
        const result = await service.listProducts(PAGINATION);
        expect(result.list.map((p) => p.id)).toEqual(['a', 'c']);
    });
    it('exposes name, image, points cost and availability for each item (需求 4.1)', async () => {
        const repo = new FakeRepo([
            makeProduct({ id: 'a', name: 'Cup', pointsCost: 42, imageUrl: 'https://cdn/x.jpg', stock: 3 }),
        ]);
        const service = new CatalogService({ repository: repo });
        const [item] = (await service.listProducts(PAGINATION)).list;
        expect(item).toEqual({
            id: 'a',
            name: 'Cup',
            pointsCost: 42,
            imageUrl: 'https://cdn/x.jpg',
            isPlaceholder: false,
            stock: 3,
            available: true,
        });
    });
    it('falls back to a placeholder when a product has no image (需求 4.6)', async () => {
        const repo = new FakeRepo([makeProduct({ id: 'a', imageUrl: null })]);
        const service = new CatalogService({ repository: repo });
        const [item] = (await service.listProducts(PAGINATION)).list;
        expect(item.imageUrl).toBe(PLACEHOLDER_IMAGE_URL);
        expect(item.isPlaceholder).toBe(true);
    });
    it('marks zero-stock products as unavailable / 已兑完 (需求 5.1 语义)', async () => {
        const repo = new FakeRepo([makeProduct({ id: 'a', stock: 0 })]);
        const service = new CatalogService({ repository: repo });
        const [item] = (await service.listProducts(PAGINATION)).list;
        expect(item.stock).toBe(0);
        expect(item.available).toBe(false);
    });
    it('uses the injected stock resolver seam (task 5.4 virtual stock)', async () => {
        // Virtual product with a stale stored stock; resolver overrides to CDK count.
        const repo = new FakeRepo([makeProduct({ id: 'v', type: ProductType.Virtual, stock: 0 })]);
        const stockResolver = (p) => (p.type === ProductType.Virtual ? 7 : p.stock);
        const service = new CatalogService({ repository: repo, stockResolver });
        const [item] = (await service.listProducts(PAGINATION)).list;
        expect(item.stock).toBe(7);
        expect(item.available).toBe(true);
    });
    it('propagates pagination metadata', async () => {
        const repo = new FakeRepo([makeProduct({ id: 'a' })]);
        const service = new CatalogService({ repository: repo });
        const result = await service.listProducts({ page: 2, pageSize: 10 });
        expect(result.page).toBe(2);
        expect(result.pageSize).toBe(10);
        expect(result.total).toBe(1);
    });
});
// ---------------------------------------------------------------------------
// searchProducts
// ---------------------------------------------------------------------------
describe('CatalogService.searchProducts', () => {
    it('returns listed products whose name matches the keyword, case-insensitively (需求 4.3)', async () => {
        const repo = new FakeRepo([
            makeProduct({ id: 'a', name: 'Coffee Mug', status: ProductStatus.Listed }),
            makeProduct({ id: 'b', name: 'Tea Cup', status: ProductStatus.Listed }),
            makeProduct({ id: 'c', name: 'MUG holder', status: ProductStatus.Listed }),
        ]);
        const service = new CatalogService({ repository: repo });
        const result = await service.searchProducts('mug', PAGINATION);
        expect(result.list.map((p) => p.id)).toEqual(['a', 'c']);
    });
    it('never returns unlisted products even if the name matches (Property 8)', async () => {
        const repo = new FakeRepo([
            makeProduct({ id: 'a', name: 'Mug', status: ProductStatus.Listed }),
            makeProduct({ id: 'b', name: 'Mug', status: ProductStatus.Unlisted }),
        ]);
        const service = new CatalogService({ repository: repo });
        const result = await service.searchProducts('mug', PAGINATION);
        expect(result.list.map((p) => p.id)).toEqual(['a']);
    });
    it('returns an empty list when nothing matches (需求 4.4)', async () => {
        const repo = new FakeRepo([makeProduct({ id: 'a', name: 'Mug' })]);
        const service = new CatalogService({ repository: repo });
        const result = await service.searchProducts('nonexistent', PAGINATION);
        expect(result.list).toEqual([]);
    });
    it('treats an empty keyword as browse-all listed (Property 8 空关键字表示浏览)', async () => {
        const repo = new FakeRepo([
            makeProduct({ id: 'a', status: ProductStatus.Listed }),
            makeProduct({ id: 'b', status: ProductStatus.Unlisted }),
        ]);
        const service = new CatalogService({ repository: repo });
        const result = await service.searchProducts('   ', PAGINATION);
        expect(result.list.map((p) => p.id)).toEqual(['a']);
    });
});
// ---------------------------------------------------------------------------
// getProduct
// ---------------------------------------------------------------------------
describe('CatalogService.getProduct', () => {
    it('returns detail with type, description and gallery (主图在前) (需求 4.5)', async () => {
        const repo = new FakeRepo([makeProduct({ id: 'p', name: 'Gadget', type: ProductType.Virtual, description: 'desc', pointsCost: 55, stock: 2 })], [
            makeImage({ id: 'i1', productId: 'p', isPrimary: false, sortOrder: 1, url: 'u1' }),
            makeImage({ id: 'i2', productId: 'p', isPrimary: true, sortOrder: 2, url: 'u2' }),
            makeImage({ id: 'i3', productId: 'p', isPrimary: false, sortOrder: 0, url: 'u3' }),
        ]);
        const service = new CatalogService({ repository: repo });
        const detail = await service.getProduct('p');
        expect(detail).not.toBeNull();
        expect(detail.type).toBe(ProductType.Virtual);
        expect(detail.description).toBe('desc');
        expect(detail.pointsCost).toBe(55);
        // primary first, then remaining by sortOrder asc.
        expect(detail.images.map((i) => i.id)).toEqual(['i2', 'i3', 'i1']);
        expect(detail.imageUrl).toBe('u2');
        expect(detail.isPlaceholder).toBe(false);
        expect(detail.available).toBe(true);
    });
    it('returns null when the product does not exist', async () => {
        const service = new CatalogService({ repository: new FakeRepo() });
        expect(await service.getProduct('missing')).toBeNull();
    });
    it('uses a placeholder when the product has no images and no cached image (需求 4.6)', async () => {
        const repo = new FakeRepo([makeProduct({ id: 'p', imageUrl: null })], []);
        const service = new CatalogService({ repository: repo });
        const detail = await service.getProduct('p');
        expect(detail.images).toEqual([]);
        expect(detail.imageUrl).toBe(PLACEHOLDER_IMAGE_URL);
        expect(detail.isPlaceholder).toBe(true);
    });
    it('resolves virtual stock through the injected resolver seam (task 5.4)', async () => {
        const repo = new FakeRepo([makeProduct({ id: 'v', type: ProductType.Virtual, stock: 0 })], []);
        const service = new CatalogService({
            repository: repo,
            stockResolver: (p) => (p.type === ProductType.Virtual ? 3 : p.stock),
        });
        const detail = await service.getProduct('v');
        expect(detail.stock).toBe(3);
        expect(detail.available).toBe(true);
    });
});
