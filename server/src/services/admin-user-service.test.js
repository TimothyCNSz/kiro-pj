import { describe, it, expect } from 'vitest';
import { AdminUserService, } from './admin-user-service';
import { AccountStatus, Role } from '../lib/domain';
// ---------------------------------------------------------------------------
// Fake repository — 内存实现，模拟 users 左联 pointsAccounts 的过滤 + 分页。
// 不触达真实数据库。
// ---------------------------------------------------------------------------
class FakeAdminUserRepository {
    all;
    lastKeyword = null;
    lastPagination = null;
    constructor(all) {
        this.all = all;
    }
    async listUsers(keyword, pagination) {
        this.lastKeyword = keyword;
        this.lastPagination = pagination;
        const q = keyword.trim().toLowerCase();
        const matched = q.length === 0 ? this.all : this.all.filter((u) => u.email.toLowerCase().includes(q));
        const start = (pagination.page - 1) * pagination.pageSize;
        const rows = matched.slice(start, start + pagination.pageSize);
        return { rows, total: matched.length };
    }
}
function row(overrides) {
    return {
        role: Role.Employee,
        status: AccountStatus.Active,
        balance: 0,
        ...overrides,
    };
}
const SAMPLE = [
    row({ userId: 'u1', email: 'alice@corp.com', balance: 100 }),
    row({ userId: 'u2', email: 'bob@corp.com', balance: 50, status: AccountStatus.PendingVerification }),
    row({ userId: 'u3', email: 'carol@other.com', balance: 0 }),
    row({ userId: 'u4', email: 'admin@corp.com', role: Role.Admin, balance: 999 }),
];
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('AdminUserService.listUsers', () => {
    it('returns all users when q is empty/omitted (需求 24.1, 24.2 浏览语义)', async () => {
        const repo = new FakeAdminUserRepository(SAMPLE);
        const service = new AdminUserService({ repository: repo });
        const result = await service.listUsers({ page: 1, pageSize: 20 });
        expect(result.list.map((u) => u.userId)).toEqual(['u1', 'u2', 'u3', 'u4']);
        expect(result.total).toBe(4);
    });
    it('each row includes userId/email/role/status/balance (需求 24.1)', async () => {
        const repo = new FakeAdminUserRepository(SAMPLE);
        const service = new AdminUserService({ repository: repo });
        const [item] = (await service.listUsers({ page: 1, pageSize: 20 })).list;
        expect(item).toEqual({
            userId: 'u1',
            email: 'alice@corp.com',
            role: Role.Employee,
            status: AccountStatus.Active,
            balance: 100,
        });
    });
    it('filters by email keyword, case-insensitive (需求 24.2)', async () => {
        const repo = new FakeAdminUserRepository(SAMPLE);
        const service = new AdminUserService({ repository: repo });
        const result = await service.listUsers({ q: 'CORP', page: 1, pageSize: 20 });
        // alice/bob/admin 邮箱含 corp（大小写不敏感）；carol@other.com 不含。
        expect(result.list.map((u) => u.userId)).toEqual(['u1', 'u2', 'u4']);
        expect(result.total).toBe(3);
    });
    it('trims whitespace-only q to browse-all (需求 24.2)', async () => {
        const repo = new FakeAdminUserRepository(SAMPLE);
        const service = new AdminUserService({ repository: repo });
        const result = await service.listUsers({ q: '   ', page: 1, pageSize: 20 });
        expect(result.list).toHaveLength(4);
        expect(repo.lastKeyword).toBe('');
    });
    it('returns an empty list when no email matches (需求 24.3 空状态)', async () => {
        const repo = new FakeAdminUserRepository(SAMPLE);
        const service = new AdminUserService({ repository: repo });
        const result = await service.listUsers({ q: 'nobody@nowhere', page: 1, pageSize: 20 });
        expect(result.list).toEqual([]);
        expect(result.total).toBe(0);
    });
    it('paginates results and echoes page/pageSize (需求 24.4)', async () => {
        const repo = new FakeAdminUserRepository(SAMPLE);
        const service = new AdminUserService({ repository: repo });
        const result = await service.listUsers({ page: 2, pageSize: 2 });
        expect(result.list.map((u) => u.userId)).toEqual(['u3', 'u4']);
        expect(result.page).toBe(2);
        expect(result.pageSize).toBe(2);
        expect(result.total).toBe(4);
    });
    it('defensively drops rows whose email does not match, regardless of repo output (Property 37 不变式)', async () => {
        // 恶意/有缺陷的仓储：返回不匹配关键字的行；服务层须过滤掉它。
        const buggyRepo = {
            async listUsers() {
                return {
                    rows: [
                        row({ userId: 'u1', email: 'alice@corp.com' }),
                        row({ userId: 'x', email: 'mismatch@zzz.com' }),
                    ],
                    total: 2,
                };
            },
        };
        const service = new AdminUserService({ repository: buggyRepo });
        const result = await service.listUsers({ q: 'corp', page: 1, pageSize: 20 });
        expect(result.list.map((u) => u.userId)).toEqual(['u1']);
    });
});
