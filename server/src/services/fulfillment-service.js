// FulfillmentService — 发货管理：实物发货 / 虚拟发货（需求 8.1–8.4, 9.3, 9.4, 14.1, 14.2, 14.3, 14.4）。
//
// 职责（见设计「后端 API 契约 · 管理-发货」「关键服务接口 · FulfillmentService」
// + Correctness Property 21/22/23）：
//   - shipPhysical：为某实物订单上传物流编号。物流编号去空白后**必须非空**，否则拒绝
//     将订单标记为已发货并以 `TRACKING_REQUIRED` 上抛（需求 14.3、8.2）；校验通过则记录
//     物流编号并将订单状态置为「已发货」（shipped，需求 8.2、14.1）。未发货的实物订单
//     状态显示为「待发货」（pending_shipment，需求 8.4，由读取路径体现）。已发货后可展示
//     物流跟踪明细——本阶段以假数据呈现（需求 8.3；见 {@link buildFakeTrackingTimeline}）。
//     仅适用于实物订单。
//   - shipVirtual：为某虚拟订单完成虚拟发货。发货前该虚拟订单状态为「待发货」且不展示
//     CDK（需求 9.3，由订单详情读取路径 task 11.7 门控）；发货时将该订单已关联的 CDK
//     置为 delivered（关联/交付，需求 9.4、14.2）并把订单状态置为「已发货」。发货后订单
//     详情读取路径即展示对应 CDK（需求 9.4）。仅适用于虚拟订单。
//
// 事务边界（关键）：每个发货操作在**单个数据库事务内**完成「订单状态变更 + 操作日志」，
// 使二者同成败（需求 14.4：任一发货操作完成即记录一条操作日志）。为此本服务：
//   - 通过可注入的 {@link FulfillmentRepository.transaction} 运行整段发货逻辑；
//   - 在事务内把事务句柄透传给仓储写入方法与 {@link OperationLogRecorder.recordLog}，
//     让日志写入复用同一事务（与 LogService/AlertService 一致的接缝）。
//
// 设计接缝（依赖可注入，测试用内存替身、不触达真实数据库）：
//   - FulfillmentRepository：订单读取 + 实物/虚拟发货状态迁移的数据访问抽象（默认 Drizzle）。
//   - OperationLogRecorder：操作日志记录抽象（默认 {@link LogService}），在事务内被调用。
//
// Requirements: 8.1, 8.2, 8.3, 8.4, 9.3, 9.4, 14.1, 14.2, 14.4.
import { eq } from 'drizzle-orm';
import { db as defaultDb } from '../db/client';
import { cdks, orders } from '../db/schema';
import { OrderStatus, OrderType } from '../lib/domain';
import { ErrorCode } from '../lib/errors';
import { HttpError } from '../middleware/http-error';
import { LogService } from './log-service';
/** 空物流编号的统一提示（需求 14.3、8.2）。 */
export const TRACKING_REQUIRED_MESSAGE = '物流编号不能为空，请补充物流编号后再发货';
/** 订单类型不匹配的统一提示（对实物端点提交虚拟订单，或反之）。 */
export const ORDER_TYPE_MISMATCH_MESSAGE = '订单类型与发货方式不匹配';
/**
 * 生成假数据物流跟踪明细（需求 8.3）。纯函数、可确定性测试；本阶段仅用于演示，
 * 不对接真实物流查询。
 */
export function buildFakeTrackingTimeline(trackingNo) {
    return {
        trackingNo,
        carrier: 'AWSome 物流（演示）',
        nodes: [
            { status: '运输中', description: '快件已从仓库发出，正在运往目的地' },
            { status: '已揽收', description: `承运商已揽收快件（物流编号 ${trackingNo}）` },
        ],
    };
}
/** 基于 Drizzle 的默认发货仓储实现。 */
export class DrizzleFulfillmentRepository {
    db;
    constructor(db = defaultDb) {
        this.db = db;
    }
    async transaction(fn) {
        return this.db.transaction(async (tx) => fn(tx));
    }
    async getOrder(orderId, handle) {
        const exec = handle;
        const rows = await exec
            .select({ id: orders.id, type: orders.type, status: orders.status })
            .from(orders)
            .where(eq(orders.id, orderId))
            .limit(1);
        const row = rows[0];
        if (!row)
            return null;
        return { id: row.id, type: row.type, status: row.status };
    }
    async markPhysicalShipped(orderId, trackingNo, handle) {
        const exec = handle;
        await exec
            .update(orders)
            .set({ trackingNo, status: OrderStatus.Shipped })
            .where(eq(orders.id, orderId));
    }
    async markVirtualShipped(orderId, handle) {
        const exec = handle;
        await exec
            .update(orders)
            .set({ status: OrderStatus.Shipped })
            .where(eq(orders.id, orderId));
        // 关联并交付该订单的 CDK（兑换时已消耗并绑定 orderId，此处置为 delivered，需求 9.4）。
        const delivered = await exec
            .update(cdks)
            .set({ status: 'delivered' })
            .where(eq(cdks.orderId, orderId))
            .returning({ code: cdks.code });
        return delivered.map((r) => r.code).sort();
    }
}
/**
 * FulfillmentService：实物 / 虚拟发货（需求 8, 9.3, 9.4, 14）。
 * 每个发货操作在单事务内完成「状态迁移 + 操作日志」，二者同成败（需求 14.4）。
 */
export class FulfillmentService {
    repository;
    logService;
    constructor(options = {}) {
        this.repository = options.repository ?? new DrizzleFulfillmentRepository();
        this.logService = options.logService ?? new LogService();
    }
    /**
     * 实物发货：校验非空物流编号 → 记录编号并置「已发货」→ 记操作日志（需求 8.2, 14.1, 14.3, 14.4）。
     *
     * @throws HttpError(TRACKING_REQUIRED) 物流编号去空白后为空（需求 14.3、8.2）。
     * @throws HttpError(VALIDATION) 目标订单不是实物订单。
     * @returns 迁移结果（含假数据物流明细，需求 8.3）；订单不存在返回 null（路由转 404）。
     */
    async shipPhysical(adminId, orderId, trackingNo) {
        // 物流编号非空校验先于任何写入（需求 14.3）：仅接受去空白后非空的字符串。
        const normalized = typeof trackingNo === 'string' ? trackingNo.trim() : '';
        if (normalized.length === 0) {
            throw new HttpError(ErrorCode.TrackingRequired, TRACKING_REQUIRED_MESSAGE);
        }
        return this.repository.transaction(async (tx) => {
            const order = await this.repository.getOrder(orderId, tx);
            if (order === null)
                return null;
            if (order.type !== OrderType.Physical) {
                throw new HttpError(ErrorCode.Validation, ORDER_TYPE_MISMATCH_MESSAGE);
            }
            await this.repository.markPhysicalShipped(orderId, normalized, tx);
            // 事务内记录操作日志：发货 + 日志同成败（需求 14.4）。
            await this.logService.recordLog({ actorId: adminId, action: 'ship_physical', targetType: 'order', targetId: orderId }, tx);
            return {
                orderId,
                status: OrderStatus.Shipped,
                trackingNo: normalized,
                tracking: buildFakeTrackingTimeline(normalized),
            };
        });
    }
    /**
     * 虚拟发货：关联并交付订单 CDK → 置「已发货」→ 记操作日志（需求 9.3, 9.4, 14.2, 14.4）。
     *
     * 发货前该虚拟订单状态为「待发货」且不展示 CDK（需求 9.3，由订单详情读取路径门控）；
     * 发货后订单详情即展示对应 CDK（需求 9.4）。
     *
     * @throws HttpError(VALIDATION) 目标订单不是虚拟订单。
     * @returns 迁移结果（含交付的 CDK）；订单不存在返回 null（路由转 404）。
     */
    async shipVirtual(adminId, orderId) {
        return this.repository.transaction(async (tx) => {
            const order = await this.repository.getOrder(orderId, tx);
            if (order === null)
                return null;
            if (order.type !== OrderType.Virtual) {
                throw new HttpError(ErrorCode.Validation, ORDER_TYPE_MISMATCH_MESSAGE);
            }
            const deliveredCdks = await this.repository.markVirtualShipped(orderId, tx);
            // 事务内记录操作日志：发货 + 日志同成败（需求 14.4）。
            await this.logService.recordLog({ actorId: adminId, action: 'ship_virtual', targetType: 'order', targetId: orderId }, tx);
            return { orderId, status: OrderStatus.Shipped, cdks: deliveredCdks };
        });
    }
}
