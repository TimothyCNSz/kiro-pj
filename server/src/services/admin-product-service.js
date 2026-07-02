// AdminProductService — 商品管理：创建 / 编辑 / 上下架（需求 12.1, 12.3–12.6, 12.10）。
//
// 职责（见设计「关键服务接口」「后端 API 契约 · 管理-商品」「Data Models · Product」）：
//   - create：保存名称、图集（主图 URL 冗余缓存）、描述、所需积分、库存、上下架状态与
//     商品类型（实物/虚拟）（需求 12.1）。所需积分与库存必须为非负整数，否则拒绝保存并
//     以 `INVALID_PRODUCT_FIELD` 上抛（需求 12.5）。实物商品不强制 CDK 字段——本服务不
//     涉及 CDK，虚拟商品的 CDK 维护由独立的 CDK 服务/端点负责（需求 12.6）。
//   - update：编辑商品字段并对员工端后续浏览生效（需求 12.3）；仅校验/写入显式提供的字段。
//   - setStatus：上/下架状态切换（`PATCH /admin/products/:id/status`）。下架使商品不再对
//     员工展示且不可兑换（需求 12.4）。
//
// 本阶段不提供商品的物理删除（需求 12.10）：商品的下线通过将其设为「下架」（unlisted）
// 实现，以避免破坏与历史订单及商品图片的关联——因此本服务刻意不暴露任何 delete 方法。
//
// 所有外部依赖（商品存储、时钟）均可注入，便于以内存替身做单元测试而不触达真实数据库。
import { eq } from 'drizzle-orm';
import { db as defaultDb } from '../db/client';
import { products } from '../db/schema';
import { ProductStatus, ProductType, isProductStatus, isProductType, } from '../lib/domain';
import { ErrorCode } from '../lib/errors';
import { HttpError } from '../middleware/http-error';
/**
 * 非法商品字段错误：携带逐项字段错误，映射为 `INVALID_PRODUCT_FIELD`(422)（需求 12.5）。
 * 继承 `HttpError` 以复用统一错误中间件的错误码解析。
 */
export class ProductValidationError extends HttpError {
    fieldErrors;
    constructor(fieldErrors, message = INVALID_PRODUCT_FIELD_MESSAGE) {
        super(ErrorCode.InvalidProductField, message);
        this.name = 'ProductValidationError';
        this.fieldErrors = fieldErrors;
        Object.setPrototypeOf(this, ProductValidationError.prototype);
    }
}
/** 非法商品数值的统一提示（需求 12.5）。 */
export const INVALID_PRODUCT_FIELD_MESSAGE = '商品字段非法：所需积分与库存必须为非负整数';
/** 基于 Drizzle 的默认商品存储实现。 */
export class DrizzleProductStore {
    db;
    constructor(db = defaultDb) {
        this.db = db;
    }
    async create(values) {
        const rows = await this.db.insert(products).values(values).returning();
        const row = rows[0];
        if (!row)
            throw new Error('Failed to create product: no row returned.');
        return row;
    }
    async updateById(id, patch) {
        const rows = await this.db
            .update(products)
            .set(patch)
            .where(eq(products.id, id))
            .returning();
        return rows[0] ?? null;
    }
    async findById(id) {
        const rows = await this.db.select().from(products).where(eq(products.id, id)).limit(1);
        return rows[0] ?? null;
    }
}
// ---------------------------------------------------------------------------
// Pure field validators (需求 12.1, 12.5)
// ---------------------------------------------------------------------------
/** 非负整数判定（拒绝负数、小数、NaN、非数字，需求 12.5）。 */
function isNonNegativeInteger(v) {
    return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}
/** 非空字符串判定（去空白后长度 > 0）。 */
function isNonEmptyString(v) {
    return typeof v === 'string' && v.trim().length > 0;
}
/**
 * AdminProductService：商品创建 / 编辑 / 上下架切换。
 *
 * 所有依赖可注入；无注入时回退到基于 Drizzle 的默认存储。
 */
export class AdminProductService {
    store;
    constructor(options = {}) {
        this.store = options.store ?? new DrizzleProductStore();
    }
    /**
     * 创建商品：保存名称/图集/描述/所需积分/库存/上下架状态/类型（需求 12.1）。
     *
     * - 名称必填非空；类型须为合法商品类型；所需积分与库存须为非负整数（需求 12.5），
     *   否则抛出 `ProductValidationError`（逐项 field errors，`INVALID_PRODUCT_FIELD`）。
     * - 未显式提供时：description 缺省空串、imageUrl 缺省 null、stock 缺省 0、
     *   status 缺省 unlisted（需求 12.4）。
     */
    async create(input) {
        const fieldErrors = {};
        if (!isNonEmptyString(input.name)) {
            fieldErrors.name = 'REQUIRED';
        }
        if (!isProductType(input.type)) {
            fieldErrors.type = 'INVALID_TYPE';
        }
        if (!isNonNegativeInteger(input.pointsCost)) {
            fieldErrors.pointsCost = 'NEGATIVE_OR_INVALID';
        }
        if (input.stock !== undefined && !isNonNegativeInteger(input.stock)) {
            fieldErrors.stock = 'NEGATIVE_OR_INVALID';
        }
        if (input.status !== undefined && !isProductStatus(input.status)) {
            fieldErrors.status = 'INVALID_STATUS';
        }
        if (Object.keys(fieldErrors).length > 0) {
            throw new ProductValidationError(fieldErrors);
        }
        const values = {
            name: input.name.trim(),
            pointsCost: input.pointsCost,
            type: input.type,
            description: input.description ?? '',
            imageUrl: input.imageUrl ?? null,
            stock: input.stock ?? 0,
            status: input.status ?? ProductStatus.Unlisted,
        };
        return this.store.create(values);
    }
    /**
     * 编辑商品：仅校验并写入显式提供的字段（需求 12.3）。
     *
     * - 提供的 name 须非空；type/status 须合法；pointsCost/stock 须为非负整数（需求 12.5）。
     * - 商品不存在返回 null（由路由层映射为 404）。
     */
    async update(id, patch) {
        const fieldErrors = {};
        const values = {};
        if (patch.name !== undefined) {
            if (!isNonEmptyString(patch.name))
                fieldErrors.name = 'REQUIRED';
            else
                values.name = patch.name.trim();
        }
        if (patch.type !== undefined) {
            if (!isProductType(patch.type))
                fieldErrors.type = 'INVALID_TYPE';
            else
                values.type = patch.type;
        }
        if (patch.pointsCost !== undefined) {
            if (!isNonNegativeInteger(patch.pointsCost))
                fieldErrors.pointsCost = 'NEGATIVE_OR_INVALID';
            else
                values.pointsCost = patch.pointsCost;
        }
        if (patch.stock !== undefined) {
            if (!isNonNegativeInteger(patch.stock))
                fieldErrors.stock = 'NEGATIVE_OR_INVALID';
            else
                values.stock = patch.stock;
        }
        if (patch.status !== undefined) {
            if (!isProductStatus(patch.status))
                fieldErrors.status = 'INVALID_STATUS';
            else
                values.status = patch.status;
        }
        if (patch.description !== undefined) {
            values.description = patch.description;
        }
        if (patch.imageUrl !== undefined) {
            values.imageUrl = patch.imageUrl;
        }
        if (Object.keys(fieldErrors).length > 0) {
            throw new ProductValidationError(fieldErrors);
        }
        // 无可写字段：直接回读当前商品（不发起空更新）。
        if (Object.keys(values).length === 0) {
            return this.store.findById(id);
        }
        return this.store.updateById(id, values);
    }
    /**
     * 上/下架状态切换（`PATCH /admin/products/:id/status`，需求 12.4）。
     *
     * - status 须为合法商品状态（listed/unlisted），否则抛出 `ProductValidationError`。
     * - 商品不存在返回 null（由路由层映射为 404）。
     * - 下架（unlisted）使商品不再对员工端展示且不可兑换（需求 4.2, 12.4）。
     */
    async setStatus(id, status) {
        if (!isProductStatus(status)) {
            throw new ProductValidationError({ status: 'INVALID_STATUS' });
        }
        return this.store.updateById(id, { status });
    }
}
// Re-export for convenience so callers can reference the status literal type.
export { ProductStatus, ProductType };
