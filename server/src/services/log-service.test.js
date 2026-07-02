import { describe, it, expect } from 'vitest';
import { LogService, } from './log-service';
// ---------------------------------------------------------------------------
// Fake gateway (in-memory, no real DB)
//
// Mirrors the SQL semantics: appends each inserted log, and lists them newest
// first (ORDER BY created_at DESC) with LIMIT/OFFSET paging (需求 16.1, 16.2).
// Insertion order stands in for created_at ordering.
// ---------------------------------------------------------------------------
class FakeLogGateway {
    /** stored logs in insertion order (oldest first). */
    logs = [];
    /** records the handle passed to each write, to assert tx pass-through. */
    receivedHandles = [];
    seq = 0;
    async insertLog(entry, handle) {
        this.receivedHandles.push(handle);
        this.seq += 1;
        this.logs.push({
            id: `log-${this.seq}`,
            actorId: entry.actorId,
            action: entry.action,
            targetType: entry.targetType,
            targetId: entry.targetId ?? null,
            // Later inserts get later timestamps.
            createdAt: new Date(this.seq),
        });
    }
    async listLogs(pagination) {
        // Newest first (需求 16.2).
        const sorted = [...this.logs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const page = pagination.page > 0 ? pagination.page : 1;
        const pageSize = pagination.pageSize > 0 ? pagination.pageSize : 20;
        const offset = (page - 1) * pageSize;
        return { rows: sorted.slice(offset, offset + pageSize), total: sorted.length };
    }
}
const PAGINATION = { page: 1, pageSize: 20 };
// ---------------------------------------------------------------------------
// LogService.recordLog — 记录操作日志 (需求 16.1, 14.4)
// ---------------------------------------------------------------------------
describe('LogService.recordLog', () => {
    it('records a log with actor / action / target (需求 16.1)', async () => {
        const gateway = new FakeLogGateway();
        const service = new LogService({ gateway });
        await service.recordLog({
            actorId: 'admin-1',
            action: 'product_create',
            targetType: 'product',
            targetId: 'p1',
        });
        const { list } = await service.listLogs(PAGINATION);
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({
            actorId: 'admin-1',
            action: 'product_create',
            targetType: 'product',
            targetId: 'p1',
        });
        expect(list[0]?.createdAt).toBeInstanceOf(Date);
    });
    it('records one log per operation across the supported action types (需求 16.1, 14.4)', async () => {
        const gateway = new FakeLogGateway();
        const service = new LogService({ gateway });
        const actions = [
            'product_create',
            'product_update',
            'product_status',
            'points_grant',
            'points_deduct',
            'ship_physical',
            'ship_virtual',
        ];
        for (const action of actions) {
            await service.recordLog({ actorId: 'admin-1', action, targetType: 't', targetId: 'x' });
        }
        const { list, total } = await service.listLogs({ page: 1, pageSize: 100 });
        expect(total).toBe(actions.length);
        // newest-first, so reverse of insertion order.
        expect(list.map((l) => l.action)).toEqual([...actions].reverse());
    });
    it('allows a null target id', async () => {
        const gateway = new FakeLogGateway();
        const service = new LogService({ gateway });
        await service.recordLog({ actorId: 'admin-1', action: 'points_grant', targetType: 'user' });
        const { list } = await service.listLogs(PAGINATION);
        expect(list[0]?.targetId).toBeNull();
    });
    it('forwards the optional transaction handle to the gateway (事务参与)', async () => {
        const gateway = new FakeLogGateway();
        const service = new LogService({ gateway });
        const fakeTx = { marker: 'tx' };
        await service.recordLog({ actorId: 'admin-1', action: 'points_deduct', targetType: 'user', targetId: 'u1' }, fakeTx);
        expect(gateway.receivedHandles).toEqual([fakeTx]);
    });
});
// ---------------------------------------------------------------------------
// LogService.listLogs — 时间倒序 + 分页 (需求 16.2)
// ---------------------------------------------------------------------------
describe('LogService.listLogs', () => {
    it('returns an empty list when there are no logs', async () => {
        const service = new LogService({ gateway: new FakeLogGateway() });
        const result = await service.listLogs(PAGINATION);
        expect(result.list).toEqual([]);
        expect(result.total).toBe(0);
    });
    it('orders logs newest-first (需求 16.2)', async () => {
        const gateway = new FakeLogGateway();
        const service = new LogService({ gateway });
        await service.recordLog({ actorId: 'a', action: 'product_create', targetType: 'product', targetId: 'first' });
        await service.recordLog({ actorId: 'a', action: 'product_update', targetType: 'product', targetId: 'second' });
        await service.recordLog({ actorId: 'a', action: 'product_status', targetType: 'product', targetId: 'third' });
        const { list } = await service.listLogs(PAGINATION);
        expect(list.map((l) => l.targetId)).toEqual(['third', 'second', 'first']);
    });
    it('paginates newest-first and echoes pagination metadata', async () => {
        const gateway = new FakeLogGateway();
        const service = new LogService({ gateway });
        // 5 logs: targetId 'log-0' .. 'log-4' (oldest .. newest).
        for (let i = 0; i < 5; i += 1) {
            await service.recordLog({ actorId: 'a', action: 'points_grant', targetType: 'user', targetId: `log-${i}` });
        }
        const first = await service.listLogs({ page: 1, pageSize: 2 });
        expect(first.total).toBe(5);
        expect(first.page).toBe(1);
        expect(first.pageSize).toBe(2);
        expect(first.list.map((l) => l.targetId)).toEqual(['log-4', 'log-3']);
        const second = await service.listLogs({ page: 2, pageSize: 2 });
        expect(second.list.map((l) => l.targetId)).toEqual(['log-2', 'log-1']);
        const third = await service.listLogs({ page: 3, pageSize: 2 });
        expect(third.list.map((l) => l.targetId)).toEqual(['log-0']);
    });
});
