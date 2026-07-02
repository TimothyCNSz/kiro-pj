// AuthService — 注册 / 登录 / 登出（需求 1.3–1.6, 1.12–1.14, 1.5, 2.5）。
//
// 职责（见设计「注册与邮箱验证流程」「关键服务接口」「错误响应约定」）：
//   - register：校验邮箱域名(1.2/1.7) + 密码强度(1.1/1.6) + 邮箱唯一性(1.5)；通过后在
//     单事务内创建「待验证」员工账号(1.3/1.4) 与 `PointsAccount(balance=0)`；随后触发
//     验证邮件。邮件发送失败不回滚账号，改以 `emailSendFailed=true` 上抛（设计
//     「发送失败不回滚账号」，需求 1.4）。
//   - login：仅 `active` 账号可登录(1.12)；`pending_verification` 即便凭据正确亦返回
//     `EMAIL_NOT_VERIFIED`(1.13)；邮箱不存在或口令错误统一返回不可区分的「邮箱或密码
//     错误」(1.14)。口令仅以哈希比对。成功建立空闲会话并签发 JWT，返回 { token, role }。
//   - logout：立即终止当前会话(2.5)。
//
// 所有外部依赖（用户存储、邮箱验证服务、会话服务、口令哈希、JWT 签发、时钟、
// 公司域名白名单）均可注入，便于属性/单元测试（任务 3.8/3.9/3.10）在无真实数据库、
// SES、AWS 的前提下验证。
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { db as defaultDb } from '../db/client';
import { pointsAccounts, users } from '../db/schema';
import { AccountStatus, Role } from '../lib/domain';
import { ErrorCode } from '../lib/errors';
import { hashPassword, verifyPassword } from '../lib/password';
import { getCompanyEmailDomains, parseEmailDomain, validateEmailDomain, validatePassword, } from '../lib/validation';
import { HttpError } from '../middleware/http-error';
import { DrizzleSessionService } from './session-service';
/** 登录失败的统一、不可区分提示（需求 1.14）。 */
export const INVALID_CREDENTIALS_MESSAGE = '邮箱或密码错误';
/** 未验证账号登录提示（需求 1.13）。 */
export const EMAIL_NOT_VERIFIED_MESSAGE = '邮箱尚未验证，请先完成邮箱验证';
/**
 * 校验失败错误：携带逐项字段错误（需求 1.6/1.7），映射为 `VALIDATION`(422)。
 * 继承 `HttpError` 以复用统一错误中间件的错误码解析。
 */
export class ValidationError extends HttpError {
    fieldErrors;
    constructor(fieldErrors, message = 'VALIDATION') {
        super(ErrorCode.Validation, message);
        this.name = 'ValidationError';
        this.fieldErrors = fieldErrors;
        Object.setPrototypeOf(this, ValidationError.prototype);
    }
}
/** PostgreSQL 唯一约束冲突（SQLSTATE 23505）判定。 */
function isUniqueViolation(err) {
    return (typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        err.code === '23505');
}
/** 基于 Drizzle 的默认认证存储实现。 */
export class DrizzleAuthStore {
    db;
    constructor(db = defaultDb) {
        this.db = db;
    }
    async findByEmail(email) {
        const rows = await this.db
            .select({
            id: users.id,
            passwordHash: users.passwordHash,
            role: users.role,
            status: users.status,
        })
            .from(users)
            .where(eq(users.email, email))
            .limit(1);
        const row = rows[0];
        if (!row)
            return null;
        return {
            id: row.id,
            passwordHash: row.passwordHash,
            role: row.role,
            status: row.status,
        };
    }
    async createEmployeeWithPointsAccount(input) {
        try {
            return await this.db.transaction(async (tx) => {
                const rows = await tx
                    .insert(users)
                    .values({
                    email: input.email,
                    passwordHash: input.passwordHash,
                    role: Role.Employee,
                    status: AccountStatus.PendingVerification,
                })
                    .returning({ id: users.id });
                const userId = rows[0]?.id;
                if (!userId) {
                    throw new Error('Failed to create user: no id returned.');
                }
                await tx.insert(pointsAccounts).values({ userId, balance: 0 });
                return { userId };
            });
        }
        catch (err) {
            if (isUniqueViolation(err)) {
                throw new HttpError(ErrorCode.EmailTaken, '该邮箱已被注册');
            }
            throw err;
        }
    }
}
/** 基于 `jsonwebtoken` 的默认签发实现（HS256）。 */
export class JwtTokenSigner {
    secret;
    expiresInSeconds;
    constructor(options = {}) {
        this.secret = options.secret ?? process.env.JWT_SECRET ?? '';
        this.expiresInSeconds = options.expiresInSeconds;
    }
    sign(payload) {
        if (!this.secret) {
            throw new Error('JWT_SECRET is not set. A signing secret is required to issue tokens.');
        }
        const options = {};
        if (this.expiresInSeconds !== undefined) {
            options.expiresIn = this.expiresInSeconds;
        }
        return jwt.sign(payload, this.secret, options);
    }
}
/** 将邮箱规范化（去空白 + 转小写）用于存储与查找的一致性。 */
function normalizeEmail(email) {
    return typeof email === 'string' ? email.trim().toLowerCase() : '';
}
/**
 * AuthService：注册、登录、登出。
 *
 * 所有依赖可注入；无注入时回退到基于 Drizzle / scrypt / JWT_SECRET 的默认实现。
 */
export class AuthService {
    store;
    emailVerificationService;
    sessionService;
    tokenSigner;
    companyEmailDomains;
    hash;
    verify;
    now;
    /** 惰性计算的哑哈希：登录时用户不存在也执行一次比对，抹平时序差异。 */
    dummyHash;
    constructor(options) {
        this.store = options.store ?? new DrizzleAuthStore();
        this.emailVerificationService = options.emailVerificationService;
        this.sessionService = options.sessionService ?? new DrizzleSessionService();
        this.tokenSigner = options.tokenSigner ?? new JwtTokenSigner();
        this.companyEmailDomains = options.companyEmailDomains ?? getCompanyEmailDomains();
        this.hash = options.hashPassword ?? hashPassword;
        this.verify = options.verifyPassword ?? verifyPassword;
        this.now = options.now ?? (() => new Date());
    }
    /**
     * 注册：校验域名/强度/唯一性 → 创建待验证员工账号 + 零余额积分账户 → 触发验证邮件。
     *
     * - 校验失败（邮箱格式/公司域名/密码强度）抛出 `ValidationError`（逐项 field errors，需求 1.6/1.7）。
     * - 邮箱已存在抛出 `EMAIL_TAKEN`（需求 1.5）。
     * - 账号创建成功后发信失败不回滚，`emailSendFailed=true` 返回（需求 1.4）。
     */
    async register(email, password) {
        const normalizedEmail = normalizeEmail(email);
        // 逐项校验（需求 1.6/1.7）：先收集字段错误，再统一抛出。
        const fieldErrors = {};
        const domain = parseEmailDomain(normalizedEmail);
        if (domain === null) {
            fieldErrors.email = 'INVALID_EMAIL_FORMAT';
        }
        else if (!validateEmailDomain(normalizedEmail, this.companyEmailDomains)) {
            // 邮箱格式合法但不属于公司域名（需求 1.7）。
            fieldErrors.email = 'COMPANY_DOMAIN_REQUIRED';
        }
        if (!validatePassword(password)) {
            fieldErrors.password = 'WEAK_PASSWORD';
        }
        if (Object.keys(fieldErrors).length > 0) {
            throw new ValidationError(fieldErrors);
        }
        // 唯一性预检查（需求 1.5）；存储层另有唯一约束兜底并发写入。
        const existing = await this.store.findByEmail(normalizedEmail);
        if (existing) {
            throw new HttpError(ErrorCode.EmailTaken, '该邮箱已被注册');
        }
        const passwordHash = this.hash(password);
        const { userId } = await this.store.createEmployeeWithPointsAccount({
            email: normalizedEmail,
            passwordHash,
        });
        // 发信作为账号创建后的动作；失败不回滚账号（设计「发送失败不回滚账号」）。
        let emailSendFailed = false;
        try {
            await this.emailVerificationService.issue(userId);
        }
        catch {
            emailSendFailed = true;
        }
        return { userId, status: AccountStatus.PendingVerification, emailSendFailed };
    }
    /**
     * 登录：仅 `active` 账号（需求 1.12）。
     *
     * - 邮箱不存在或口令错误：统一返回不可区分的「邮箱或密码错误」（需求 1.14）。
     * - 凭据正确但账号处于 `pending_verification`：返回 `EMAIL_NOT_VERIFIED`（需求 1.13）。
     * - 成功：建立空闲会话（需求 2.1）并签发 JWT，返回 { token, role }。
     */
    async login(email, password) {
        const normalizedEmail = normalizeEmail(email);
        const user = await this.store.findByEmail(normalizedEmail);
        // 无论用户是否存在都执行一次口令比对，抹平时序差异，避免枚举邮箱。
        const passwordOk = user
            ? this.verify(password, user.passwordHash)
            : this.verify(password, this.getDummyHash());
        if (!user || !passwordOk) {
            throw new HttpError(ErrorCode.Unauthenticated, INVALID_CREDENTIALS_MESSAGE);
        }
        // 凭据正确但未激活：与凭据错误区分（需求 1.13）。
        if (user.status !== AccountStatus.Active) {
            throw new HttpError(ErrorCode.EmailNotVerified, EMAIL_NOT_VERIFIED_MESSAGE);
        }
        const { sessionId } = await this.sessionService.create(user.id, this.now());
        const token = this.tokenSigner.sign({ sub: user.id, sid: sessionId, role: user.role });
        return { token, role: user.role };
    }
    /** 登出：立即终止当前会话（需求 2.5）。 */
    async logout(sessionId) {
        await this.sessionService.revoke(sessionId, this.now());
    }
    /** 惰性生成并缓存哑哈希，供不存在用户的登录路径做等时比对。 */
    getDummyHash() {
        if (this.dummyHash === undefined) {
            this.dummyHash = this.hash('invalid-credentials-placeholder');
        }
        return this.dummyHash;
    }
}
