// LogService — 操作日志（记录 + 时间倒序展示，需求 16.1, 16.2, 14.4）。
//
// 职责（见设计「后端 API 契约」管理-日志分组 + Correctness Property 27）：
//   - recordLog：为一次管理操作记录一条操作日志，包含操作人（actorId）、操作类型
//     （action）、操作对象（targetType/targetId）与操作时间（createdAt，由数据库
//     默认 now() 落库）。适用的操作类型见 {@link OperationAction}：商品增改
//     （product_create/product_update）、上下架（product_status）、积分发放/扣除
//     （points_grant/points_deduct）、实物/虚拟发货（ship_physical/ship_virtual）
//     （需求 16.1, 14.4）。
//   - listLogs：按操作时间从新到旧（createdAt 倒序）分页返回日志（需求 16.2）。
//
// 事务参与（关键，与 AlertService 一致的接缝）：
//   积分（PointsService，任务 11.1/11.5）与发货（FulfillmentService，任务 10.1/10.4）
//   服务在**各自的数据库事务内**调用 `recordLog(entry, tx)` 以保证「业务变更 + 日志」
//   同成败。为此写入方法接受一个**可选的事务/数据库句柄**（{@link DbOrTx}）：传入则
//   复用调用方事务，省略则使用模块作用域的默认连接自成一次写入。
//
// 设计接缝（依赖可注入，测试用内存替身、不触达真实数据库）：
//   - LogGateway：操作日志的数据访问抽象（默认基于 Drizzle）。倒序 + 分页在 SQL 层
//     以 `ORDER BY created_at DESC` + LIMIT/OFFSET 实现；内存替身以插入顺序模拟
//     同一「时间倒序」语义，使 Property 27 可脱离真实数据库独立验证。
//
// Requirements: 16.1, 16.2, 14.4.
import { desc } from 'drizzle-orm';
import { db as defaultDb } from '../db/client';
import { operationLogs } from '../db/schema';
/** 计算 SQL LIMIT/OFFSET（page 从 1 起，非法值回退安全默认）。 */
function toLimitOffset(pagination) {
    const page = Number.isFinite(pagination.page) && pagination.page > 0 ? Math.floor(pagination.page) : 1;
    const pageSize = Number.isFinite(pagination.pageSize) && pagination.pageSize > 0
        ? Math.floor(pagination.pageSize)
        : 20;
    return { limit: pageSize, offset: (page - 1) * pageSize };
}
/** 基于 Drizzle 的默认操作日志网关实现。 */
export class DrizzleLogGateway {
    db;
    constructor(db = defaultDb) {
        this.db = db;
    }
    async insertLog(entry, handle) {
        // 复用调用方事务（若提供），否则使用默认连接自成一次写入。
        const exec = (handle ?? this.db);
        await exec.insert(operationLogs).values({
            actorId: entry.actorId,
            action: entry.action,
            targetType: entry.targetType,
            targetId: entry.targetId ?? null,
        });
    }
    async listLogs(pagination) {
        const { limit, offset } = toLimitOffset(pagination);
        const rows = await this.db
            .select({
            id: operationLogs.id,
            actorId: operationLogs.actorId,
            action: operationLogs.action,
            targetType: operationLogs.targetType,
            targetId: operationLogs.targetId,
            createdAt: operationLogs.createdAt,
        })
            .from(operationLogs)
            // 时间倒序：最新的日志排在最前（需求 16.2）。
            .orderBy(desc(operationLogs.createdAt))
            .limit(limit)
            .offset(offset);
        const counted = await this.db.select({ id: operationLogs.id }).from(operationLogs);
        return { rows: rows, total: counted.length };
    }
}
/**
 * LogService：操作日志的记录与时间倒序展示（需求 16.1, 16.2, 14.4）。
 * 依赖可注入的 {@link LogGateway}；默认使用 Drizzle 实现。
 */
export class LogService {
    gateway;
    constructor(options = {}) {
        this.gateway = options.gateway ?? new DrizzleLogGateway(options.db ?? defaultDb);
    }
    /**
     * 记录一条操作日志（需求 16.1, 14.4）。
     *
     * 积分/发货服务在**各自事务内**调用并传入 `handle` 以复用该事务，使「业务变更 + 日志」
     * 同成败；省略 `handle` 时使用默认连接自成一次写入。
     *
     * @param entry 含操作人/类型/对象的日志条目。
     * @param handle 可选事务/数据库句柄；省略时使用默认连接。
     */
    async recordLog(entry, handle) {
        await this.gateway.insertLog(entry, handle);
    }
    /**
     * 分页返回操作日志，按操作时间从新到旧排序（需求 16.2）。
     */
    async listLogs(pagination) {
        const page = await this.gateway.listLogs(pagination);
        return {
            list: page.rows,
            total: page.total,
            page: pagination.page,
            pageSize: pagination.pageSize,
        };
    }
}
