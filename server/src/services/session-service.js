// SessionService — 会话空闲过期管理（需求 2.1, 2.2, 2.3, 2.5）。
//
// 会话空闲过期在服务端权威判定（见设计「认证与会话流程（需求 1、2）」）：
//   - 会话在 RDS 的 `sessions` 表中维护 `lastActiveAt`、`expiresAt` 与 `revokedAt`。
//   - `expiresAt = lastActiveAt + 空闲窗口`（默认 60min，来自 `SESSION_IDLE_MINUTES`）。
//   - 每次受保护请求：若会话有效（未撤销且未空闲过期）则刷新 `lastActiveAt`
//     （顺延 `expiresAt`，需求 2.2）；否则拒绝（上层返回 401，需求 2.4）。
//   - 登出时置 `revokedAt` 立即终止会话（需求 2.5）。
//
// 无状态 Lambda 说明：会话有效性判定完全依赖 RDS 中的 `Session` 行，与执行环境/
// 冷启动无关（空闲过期是「数据」而非「进程内存」）。
//
// 本文件保留 AuthService（任务 3.7）依赖的最小接缝——`SessionService` 接口
// （`create`/`revoke`）、`CreatedSession`、`DrizzleSessionService`——并在其上补齐
// 任务 3.11 的空闲校验与活跃刷新：纯谓词 `isSessionValid` 单独导出（供属性测试
// 任务 3.12），刷新/校验方法置于更丰富的 `SessionManager` 接口与具体实现上，
// 避免破坏仅依赖最小接缝的 AuthService。存储以 `SessionStore` 抽象注入，便于在
// 无真实数据库下测试。
//
// Requirements: 2.1, 2.2, 2.3, 2.5.
import { and, eq, isNull } from 'drizzle-orm';
import { db as defaultDb } from '../db/client';
import { sessions } from '../db/schema';
/** 默认会话空闲过期时长（分钟，需求 2.1, 2.3）。 */
export const DEFAULT_SESSION_IDLE_MINUTES = 60;
const MS_PER_MINUTE = 60_000;
/**
 * 从环境变量 `SESSION_IDLE_MINUTES` 解析空闲过期时长（分钟），
 * 非法或缺省时回退到 {@link DEFAULT_SESSION_IDLE_MINUTES}。
 */
export function getSessionIdleMinutes() {
    const raw = process.env.SESSION_IDLE_MINUTES;
    const parsed = raw !== undefined ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_IDLE_MINUTES;
}
/**
 * 纯谓词：会话在 `now` 时刻是否有效（需求 2.2, 2.3, 2.5）。
 *
 * 有效当且仅当：`revokedAt` 为空（未登出/未撤销）且 `now <= expiresAt`
 * （未空闲过期）。无任何副作用，便于属性化测试（任务 3.12）。
 *
 * @param session 会话有效性视图（`expiresAt` 与 `revokedAt`）。
 * @param now 判定所用的当前时刻。
 * @returns 有效返回 `true`，撤销或空闲过期返回 `false`。
 */
export function isSessionValid(session, now) {
    if (session.revokedAt != null)
        return false;
    return now.getTime() <= session.expiresAt.getTime();
}
/** 基于 Drizzle 的默认会话存储实现。 */
export class DrizzleSessionStore {
    db;
    constructor(db = defaultDb) {
        this.db = db;
    }
    async insert(record) {
        const [row] = await this.db
            .insert(sessions)
            .values({
            userId: record.userId,
            lastActiveAt: record.lastActiveAt,
            expiresAt: record.expiresAt,
        })
            .returning();
        return row;
    }
    async findById(sessionId) {
        const rows = await this.db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
        return rows[0] ?? null;
    }
    async updateActivity(sessionId, lastActiveAt, expiresAt) {
        const rows = await this.db
            .update(sessions)
            .set({ lastActiveAt, expiresAt })
            // 只刷新未撤销的会话，避免复活已登出会话（需求 2.5）。
            .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
            .returning();
        return rows[0] ?? null;
    }
    async revoke(sessionId, revokedAt) {
        await this.db.update(sessions).set({ revokedAt }).where(eq(sessions.id, sessionId));
    }
}
/**
 * 基于 Drizzle 的默认会话服务实现（实现 `SessionManager`，即含最小接缝）。
 *
 * - `create` 写入 `Session(lastActiveAt=now, expiresAt=now+idle, revokedAt=null)`（需求 2.1）。
 * - `refresh`/`touch` 在有效访问时刷新 `lastActiveAt` 并顺延 `expiresAt`（需求 2.2）。
 * - `revoke` 置 `revokedAt=now`，立即终止会话（需求 2.5）。
 * - `validateAndTouch` 结合 `isSessionValid` 判定并刷新（需求 2.2, 2.3, 2.4）。
 */
export class DrizzleSessionService {
    store;
    idleMinutes;
    now;
    constructor(options = {}) {
        this.store = options.store ?? new DrizzleSessionStore(options.db ?? defaultDb);
        this.idleMinutes = options.idleMinutes ?? getSessionIdleMinutes();
        this.now = options.now ?? (() => new Date());
    }
    /** 由基准时刻计算空闲过期时刻（= 基准 + 空闲窗口）。 */
    computeExpiry(base) {
        return new Date(base.getTime() + this.idleMinutes * MS_PER_MINUTE);
    }
    async create(userId, now = this.now()) {
        const record = await this.store.insert({
            userId,
            lastActiveAt: now,
            expiresAt: this.computeExpiry(now),
        });
        return { sessionId: record.id, expiresAt: record.expiresAt };
    }
    async refresh(sessionId, now = this.now()) {
        return this.store.updateActivity(sessionId, now, this.computeExpiry(now));
    }
    async touch(sessionId, now = this.now()) {
        return this.refresh(sessionId, now);
    }
    async revoke(sessionId, now = this.now()) {
        await this.store.revoke(sessionId, now);
    }
    async validateAndTouch(sessionId, now = this.now()) {
        const session = await this.store.findById(sessionId);
        if (!session || !isSessionValid(session, now))
            return null;
        return this.refresh(sessionId, now);
    }
}
