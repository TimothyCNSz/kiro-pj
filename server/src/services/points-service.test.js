import { describe, it, expect, beforeEach } from 'vitest';
import { PointsService, } from './points-service';
import { HttpError } from '../middleware/http-error';
import { ErrorCode } from '../lib/errors';
class FakeLogRecorder {
    logs = [];
    async recordLog(entry, handle) {
        this.logs.push({ entry, handle });
    }
}
/**
 * 内存积分账户仓储：以 Map 存余额，transaction 提供操作同一 Map 的 tx；
 * 若事务体抛错则回滚（还原快照），模拟真实事务的原子性。
 */
class FakePointsRepository {
    balances;
    ledger = [];
    /** transaction 执行次数（= 每位员工各一次事务）。 */
    txCount = 0;
    /** 唯一的事务句柄标记，用于断言操作日志复用了同一事务。 */
    handleToken = Symbol('points-tx');
    constructor(balances) {
        this.balances = balances;
    }
    balanceOf(userId) {
        return this.balances.get(userId);
    }
    async transaction(fn) {
        this.txCount += 1;
        // 事务快照：抛错则整体回滚（还原余额与流水）。
        const balancesSnapshot = new Map(this.balances);
        const ledgerSnapshot = this.ledger.length;
        const self = this;
        const tx = {
            async lockAccount(userId) {
                if (!self.balances.has(userId))
                    return null;
                return { userId, balance: self.balances.get(userId) };
            },
            async applyDelta(userId, delta) {
                self.balances.set(userId, (self.balances.get(userId) ?? 0) + delta);
            },
            async insertLedger(entry) {
                self.ledger.push(entry);
            },
            handle: self.handleToken,
        };
        try {
            return await fn(tx);
        }
        catch (err) {
            // 回滚
            self.balances.clear();
            for (const [k, v] of balancesSnapshot)
                self.balances.set(k, v);
            self.ledger.length = ledgerSnapshot;
            throw err;
        }
    }
}
function buildHarness(initial) {
    const repo = new FakePointsRepository(new Map(Object.entries(initial)));
    const log = new FakeLogRecorder();
    const service = new PointsService({ repository: repo, logService: log });
    return { service, repo, log };
}
const ADMIN = 'admin-1';
// ---------------------------------------------------------------------------
// adjust — single grant / deduct (需求 13.1, 13.3, 13.5, 13.6)
// ---------------------------------------------------------------------------
describe('PointsService.adjust', () => {
    let h;
    beforeEach(() => {
        h = buildHarness({ u1: 100 });
    });
    it('grants points, increases balance, records ledger + grant log (需求 13.1, 13.6)', async () => {
        const account = await h.service.adjust(ADMIN, 'u1', 50, '季度奖励');
        expect(account).toEqual({ userId: 'u1', balance: 150 });
        expect(h.repo.balanceOf('u1')).toBe(150);
        // 流水：delta/reason/note/balanceAfter 完整（需求 13.5, 13.6）。
        expect(h.repo.ledger).toEqual([
            { userId: 'u1', delta: 50, reason: 'admin_grant', note: '季度奖励', balanceAfter: 150 },
        ]);
        // 操作日志：points_grant，复用同一事务句柄（需求 13.6）。
        expect(h.log.logs).toHaveLength(1);
        expect(h.log.logs[0].entry).toEqual({
            actorId: ADMIN,
            action: 'points_grant',
            targetType: 'user',
            targetId: 'u1',
        });
        expect(h.log.logs[0].handle).toBe(h.repo.handleToken);
    });
    it('deducts points and records a deduct log (需求 13.1, 13.6)', async () => {
        const account = await h.service.adjust(ADMIN, 'u1', -40);
        expect(account).toEqual({ userId: 'u1', balance: 60 });
        expect(h.repo.ledger).toEqual([
            { userId: 'u1', delta: -40, reason: 'admin_deduct', note: null, balanceAfter: 60 },
        ]);
        expect(h.log.logs[0].entry.action).toBe('points_deduct');
    });
    it('allows deducting the full balance down to exactly zero', async () => {
        const account = await h.service.adjust(ADMIN, 'u1', -100);
        expect(account.balance).toBe(0);
        expect(h.repo.balanceOf('u1')).toBe(0);
    });
    it('blocks a deduction that would make balance negative with INSUFFICIENT_POINTS (需求 13.3)', async () => {
        await expect(h.service.adjust(ADMIN, 'u1', -101)).rejects.toMatchObject({
            errorCode: ErrorCode.InsufficientPoints,
        });
        // 无任何副作用：余额不变、无流水、无日志（事务回滚 / 未写入）。
        expect(h.repo.balanceOf('u1')).toBe(100);
        expect(h.repo.ledger).toHaveLength(0);
        expect(h.log.logs).toHaveLength(0);
    });
    it('rejects a non-integer delta with VALIDATION', async () => {
        await expect(h.service.adjust(ADMIN, 'u1', 1.5)).rejects.toBeInstanceOf(HttpError);
        expect(h.repo.balanceOf('u1')).toBe(100);
    });
    it('rejects adjusting a non-existent account with VALIDATION', async () => {
        await expect(h.service.adjust(ADMIN, 'ghost', 10)).rejects.toMatchObject({
            errorCode: ErrorCode.Validation,
        });
        expect(h.repo.ledger).toHaveLength(0);
        expect(h.log.logs).toHaveLength(0);
    });
});
// ---------------------------------------------------------------------------
// batchAdjust — partial success (需求 13.2, 13.4, 13.6)
// ---------------------------------------------------------------------------
describe('PointsService.batchAdjust', () => {
    it('applies the same grant to every user (需求 13.2)', async () => {
        const h = buildHarness({ u1: 10, u2: 20, u3: 0 });
        const result = await h.service.batchAdjust(ADMIN, ['u1', 'u2', 'u3'], 5);
        expect(result.skipped).toEqual([]);
        expect(result.succeeded).toEqual([
            { userId: 'u1', newBalance: 15 },
            { userId: 'u2', newBalance: 25 },
            { userId: 'u3', newBalance: 5 },
        ]);
        // 每位实际执行者各记一条日志（需求 13.6）。
        expect(h.log.logs).toHaveLength(3);
        expect(h.log.logs.every((l) => l.entry.action === 'points_grant')).toBe(true);
    });
    it('skips users whose balance would go negative and deducts the rest (部分成功, 需求 13.4)', async () => {
        const h = buildHarness({ rich: 100, poor: 30, broke: 0 });
        const result = await h.service.batchAdjust(ADMIN, ['rich', 'poor', 'broke'], -50, '罚扣');
        // rich 可扣、poor/broke 会变负 → 跳过（需求 13.4）。
        expect(result.succeeded).toEqual([{ userId: 'rich', newBalance: 50 }]);
        expect(result.skipped).toEqual([
            { userId: 'poor', reason: 'INSUFFICIENT_BALANCE' },
            { userId: 'broke', reason: 'INSUFFICIENT_BALANCE' },
        ]);
        // 仅实际扣除者余额变化；被跳过者余额不变。
        expect(h.repo.balanceOf('rich')).toBe(50);
        expect(h.repo.balanceOf('poor')).toBe(30);
        expect(h.repo.balanceOf('broke')).toBe(0);
        // 每位实际执行扣除者各记一条流水 + 一条操作日志（需求 13.6）；跳过者不记。
        expect(h.repo.ledger).toEqual([
            { userId: 'rich', delta: -50, reason: 'admin_deduct', note: '罚扣', balanceAfter: 50 },
        ]);
        expect(h.log.logs).toHaveLength(1);
        expect(h.log.logs[0].entry).toMatchObject({ action: 'points_deduct', targetId: 'rich' });
    });
    it('processes each user in its own transaction (single-user atomicity)', async () => {
        const h = buildHarness({ a: 10, b: 10 });
        await h.service.batchAdjust(ADMIN, ['a', 'b'], 1);
        expect(h.repo.txCount).toBe(2);
    });
    it('log count equals the number of users actually adjusted (需求 13.6, 部分成功日志计数)', async () => {
        const h = buildHarness({ u1: 100, u2: 10, u3: 100, u4: 5 });
        const result = await h.service.batchAdjust(ADMIN, ['u1', 'u2', 'u3', 'u4'], -20);
        expect(result.succeeded.map((s) => s.userId)).toEqual(['u1', 'u3']);
        expect(result.skipped.map((s) => s.userId)).toEqual(['u2', 'u4']);
        // 日志数 = 实际执行数。
        expect(h.log.logs).toHaveLength(result.succeeded.length);
    });
    it('rejects a non-integer delta with VALIDATION before touching any user', async () => {
        const h = buildHarness({ u1: 10 });
        await expect(h.service.batchAdjust(ADMIN, ['u1'], 2.5)).rejects.toBeInstanceOf(HttpError);
        expect(h.repo.txCount).toBe(0);
        expect(h.log.logs).toHaveLength(0);
    });
});
