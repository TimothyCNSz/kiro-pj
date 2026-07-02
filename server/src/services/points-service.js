// PointsService — 管理端积分发放/扣除（单个 + 批量部分成功，需求 13.1–13.6, 10.3）。
//
// 职责（见设计「关键服务接口」PointsService + 「批量积分部分成功流程」+ Property 17/19/20）：
//   - adjust(adminId, userId, delta, note?)：对单个员工发放（delta > 0）或扣除
//     （delta < 0）积分（需求 13.1）。若扣除会使余额 < 0 则**阻止并提示余额不足**
//     （INSUFFICIENT_POINTS，需求 13.3）；允许可选备注（需求 13.5）。整个调整在**单个
//     数据库事务**内完成：相对更新余额、记一条积分流水（balanceAfter）、记一条操作日志
//     （points_grant / points_deduct，需求 13.6），三者同成败。
//   - batchAdjust(adminId, userIds[], delta, note?)：对每位员工应用相同 delta（需求 13.2）。
//     扣除时**跳过**余额将变负的员工（收集为 skipped/INSUFFICIENT_BALANCE），其余正常执行
//     （**部分成功**，需求 13.4）；每位**实际执行**调整的员工各记一条流水 + 一条操作日志
//     （需求 13.4、13.6）。每位员工在**各自独立事务**内调整（单员工原子），使某位跳过或
//     失败不影响其余（批量层面部分成功）。
//
// 一致性核心（不因 demo 定位放弃）：员工积分余额**永不为负**（需求 10.3、13.3）——服务层
// 在扣减前显式校验，数据库 `CHECK (balance >= 0)` 为最后一道防线（见 schema）。
//
// 授权约束（仅管理员可调整积分、且不接受客户端直接指定余额，需求 20.2、20.4）由路由层的
// 认证中间件 + adminGuard 保证（见 admin-points.ts）；本服务只经受控的相对增减改变余额，
// 从不接受「目标余额」入参，维系「余额 = 流水累积」（需求 10.2、20.2）。
//
// 设计接缝（依赖可注入，测试用内存替身、不触达真实数据库）：
//   - PointsRepository：以单个事务运行调整（锁账户 → 相对增减 → 记流水），并暴露事务
//     句柄供操作日志在**同一事务内**写入。默认基于 Drizzle（{@link DrizzlePointsRepository}）。
//   - LogService（{@link PointsLogRecorder}）：操作日志记录器，`recordLog(entry, handle)`
//     复用调整事务句柄，使「积分变更 + 操作日志」同成败（需求 13.6）。
//
// Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 10.3.
import { ErrorCode } from '../lib/errors';
import { HttpError } from '../middleware/http-error';
import { LogService } from './log-service';
/** 断言 delta 为整数（积分为整数，见 schema），否则以 VALIDATION 拒绝。 */
function assertIntegerDelta(delta) {
    if (typeof delta !== 'number' || !Number.isInteger(delta)) {
        throw new HttpError(ErrorCode.Validation, '积分变更量必须为整数');
    }
}
// ---------------------------------------------------------------------------
// PointsService
// ---------------------------------------------------------------------------
/**
 * PointsService：管理端积分发放/扣除（需求 13.1–13.6, 10.3）。
 *
 * `adjust` 对单个员工在单事务内相对增减余额、记流水与操作日志；扣除会使余额变负时
 * 阻止并提示余额不足（需求 13.3）。`batchAdjust` 对每位员工在各自事务内应用相同 delta，
 * 跳过会变负者、其余正常执行（部分成功，需求 13.4），每位实际执行者各记一条日志（需求 13.6）。
 * 依赖可注入的 {@link PointsRepository} 与 {@link PointsLogRecorder}；默认使用 Drizzle 实现。
 */
export class PointsService {
    repository;
    logService;
    constructor(deps = {}) {
        this.repository = deps.repository ?? new DrizzlePointsRepository();
        this.logService = deps.logService ?? new LogService();
    }
    /**
     * 对单个员工发放/扣除积分（需求 13.1、13.3、13.5、13.6）。
     *
     * @param adminId 执行操作的管理员 id（操作日志的操作人）。
     * @param userId  目标员工 id。
     * @param delta   积分变化量（> 0 发放、< 0 扣除；须为整数）。
     * @param note    可选备注/原因（需求 13.5），持久化为流水 `note`。
     * @returns 调整后的积分账户视图。
     * @throws HttpError(VALIDATION) delta 非整数，或目标积分账户不存在。
     * @throws HttpError(INSUFFICIENT_POINTS) 扣除会使余额变为负数（需求 13.3）。
     */
    async adjust(adminId, userId, delta, note) {
        assertIntegerDelta(delta);
        const outcome = await this.applyToUser(adminId, userId, delta, note);
        switch (outcome.kind) {
            case 'ok':
                return { userId, balance: outcome.newBalance };
            case 'insufficient':
                // 扣除会使余额变负：阻止并提示余额不足（需求 13.3）。
                throw new HttpError(ErrorCode.InsufficientPoints, '余额不足');
            case 'missing':
                throw new HttpError(ErrorCode.Validation, '积分账户不存在');
        }
    }
    /**
     * 对多个员工批量发放/扣除积分，扣除时跳过会变负者、其余正常执行（部分成功，
     * 需求 13.2、13.4、13.6）。
     *
     * 每位员工在**各自独立事务**内调整（单员工原子），因此某位跳过或失败不影响其余；
     * 每位实际执行调整的员工各记一条流水 + 一条操作日志（需求 13.6）。
     *
     * @param adminId 执行操作的管理员 id。
     * @param userIds 目标员工 id 列表（按给定顺序处理）。
     * @param delta   积分变化量（> 0 发放、< 0 扣除；须为整数）。
     * @param note    可选备注/原因（需求 13.5）。
     * @returns 成功与跳过的分区结果（需求 13.4）。
     * @throws HttpError(VALIDATION) delta 非整数。
     */
    async batchAdjust(adminId, userIds, delta, note) {
        assertIntegerDelta(delta);
        const succeeded = [];
        const skipped = [];
        for (const userId of userIds) {
            const outcome = await this.applyToUser(adminId, userId, delta, note);
            if (outcome.kind === 'ok') {
                succeeded.push({ userId, newBalance: outcome.newBalance });
            }
            else {
                // 余额将变负（或账户缺失）：跳过并收集，其余员工继续执行（部分成功，需求 13.4）。
                skipped.push({ userId, reason: 'INSUFFICIENT_BALANCE' });
            }
        }
        return { succeeded, skipped };
    }
    /**
     * 在单个事务内对一位员工执行调整：锁账户 → 校验非负 → 相对增减 → 记流水 → 记操作日志。
     *
     * 余额将变负（或账户缺失）时**不产生任何写入**（事务空提交），返回相应结果供调用方
     * 决定「单个抛错」或「批量跳过」。实际执行时记一条 points_grant/points_deduct 操作日志
     * （复用事务句柄，需求 13.6）。
     */
    async applyToUser(adminId, userId, delta, note) {
        return this.repository.transaction(async (tx) => {
            const account = await tx.lockAccount(userId);
            if (account === null) {
                return { kind: 'missing' };
            }
            const newBalance = account.balance + delta;
            if (newBalance < 0) {
                // 扣除会使余额变负：不写入，交由调用方处理（单个→抛错；批量→跳过），需求 13.3、13.4。
                return { kind: 'insufficient' };
            }
            const reason = delta >= 0 ? 'admin_grant' : 'admin_deduct';
            // 相对增减余额（balance >= 0 由 DB CHECK 兜底，需求 10.3）。
            await tx.applyDelta(userId, delta);
            // 记一条积分流水（余额 = 流水累积，需求 10.2、13.6、20.2）。
            await tx.insertLedger({ userId, delta, reason, note: note ?? null, balanceAfter: newBalance });
            // 记一条操作日志，复用同一事务句柄（业务变更 + 日志同成败，需求 13.6）。
            const logEntry = {
                actorId: adminId,
                action: delta >= 0 ? 'points_grant' : 'points_deduct',
                targetType: 'user',
                targetId: userId,
            };
            await this.logService.recordLog(logEntry, tx.handle);
            return { kind: 'ok', newBalance };
        });
    }
}
// ---------------------------------------------------------------------------
// Drizzle-backed default repository
// ---------------------------------------------------------------------------
import { eq, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/client';
import { pointsAccounts, pointsLedger } from '../db/schema';
/** 基于单个 Drizzle 事务的 {@link PointsTx} 实现（行锁 + 相对增减）。 */
export class DrizzlePointsTx {
    tx;
    constructor(tx) {
        this.tx = tx;
    }
    async lockAccount(userId) {
        const rows = await this.tx
            .select({ userId: pointsAccounts.userId, balance: pointsAccounts.balance })
            .from(pointsAccounts)
            .where(eq(pointsAccounts.userId, userId))
            .for('update')
            .limit(1);
        return rows[0] ?? null;
    }
    async applyDelta(userId, delta) {
        await this.tx
            .update(pointsAccounts)
            .set({
            balance: sql `${pointsAccounts.balance} + ${delta}`,
            version: sql `${pointsAccounts.version} + 1`,
        })
            .where(eq(pointsAccounts.userId, userId));
    }
    async insertLedger(entry) {
        await this.tx.insert(pointsLedger).values({
            userId: entry.userId,
            delta: entry.delta,
            reason: entry.reason,
            note: entry.note ?? null,
            balanceAfter: entry.balanceAfter,
        });
    }
    get handle() {
        return this.tx;
    }
}
/** 基于 Drizzle `db.transaction` 的默认 {@link PointsRepository} 实现。 */
export class DrizzlePointsRepository {
    db;
    constructor(db = defaultDb) {
        this.db = db;
    }
    async transaction(fn) {
        return this.db.transaction(async (tx) => fn(new DrizzlePointsTx(tx)));
    }
}
