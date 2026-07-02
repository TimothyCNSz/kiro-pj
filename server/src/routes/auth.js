// /auth 路由（需求 1、2、20；见设计「后端 API 契约」认证分组）。
//
// 挂载以下端点（相对本 Router，最终位于全局前缀 + `/auth` 之下）：
//   - POST /register            公开：校验公司邮箱/密码强度/唯一性，创建「待验证」
//                               员工账号并触发验证邮件（1.1–1.7）。
//   - GET  /verify-email?token= 公开：校验验证令牌并将账号置「已激活」（1.9, 1.10）。
//   - POST /resend-verification 公开：对「待验证」账号使旧令牌失效并重发（1.11）。
//   - POST /login               公开：仅「已激活」账号可登录，建立会话，返回 token+role
//                               （1.12, 1.13, 1.14, 2.1）。
//   - POST /logout              需认证：立即终止当前会话（2.5）。
//   - GET  /me                  需认证：返回当前用户信息（会话活跃时间由认证中间件刷新，2.2）。
//
// 端点仅负责传输编解码与统一响应信封，业务逻辑委托给可注入的
// `AuthService` / `EmailVerificationService` / `AccountGateway`；失败一律以携带
// `ErrorCode` 的 `HttpError` 上抛，交由统一错误中间件映射为 HTTP 状态与信封。
//
// Requirements: 1.9, 1.11, 1.12, 1.13, 1.14, 1.15, 2.1, 2.2, 2.5.
import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db as defaultDb } from '../db/client';
import { users } from '../db/schema';
import { success } from '../lib/api';
import { AccountStatus } from '../lib/domain';
import { ErrorCode } from '../lib/errors';
import { createAuthMiddleware } from '../middleware/auth';
import { HttpError } from '../middleware/http-error';
import { AuthService } from '../services/auth-service';
import { EmailVerificationService } from '../services/email-verification-service';
import { SesMailer } from '../services/ses-mailer';
/** 提示文案（与设计「注册与邮箱验证流程」序列图一致）。 */
export const REGISTER_OK_MESSAGE = '注册成功，请查收验证邮件完成验证';
export const REGISTER_EMAIL_FAILED_MESSAGE = '注册成功，但验证邮件发送失败，请稍后重发';
export const VERIFY_OK_MESSAGE = '验证成功，可登录';
export const VERIFY_INVALID_MESSAGE = '验证失败，请重新发送验证邮件';
export const VERIFY_EXPIRED_MESSAGE = '验证链接/验证码已过期，请重新发送验证邮件';
export const RESEND_OK_MESSAGE = '验证邮件已重发';
export const LOGIN_OK_MESSAGE = '登录成功';
export const LOGOUT_OK_MESSAGE = '已登出';
/** 基于 Drizzle 的默认账号网关实现。 */
export class DrizzleAccountGateway {
    db;
    constructor(db = defaultDb) {
        this.db = db;
    }
    async activate(userId) {
        await this.db
            .update(users)
            .set({ status: AccountStatus.Active })
            .where(eq(users.id, userId));
    }
    async findPendingUserIdByEmail(email) {
        const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
        if (!normalized)
            return null;
        const rows = await this.db
            .select({ id: users.id, status: users.status })
            .from(users)
            .where(eq(users.email, normalized))
            .limit(1);
        const row = rows[0];
        if (!row || row.status !== AccountStatus.PendingVerification)
            return null;
        return row.id;
    }
}
/** 安全地将未知输入取为字符串（非字符串回退空串，交由下游校验）。 */
const asString = (v) => (typeof v === 'string' ? v : '');
/** 包裹异步处理器，将 rejection 转交 Express 错误中间件。 */
const asyncHandler = (fn) => (req, res, next) => {
    fn(req, res).catch(next);
};
/**
 * 创建 `/auth` 路由。公开端点：register/verify-email/resend-verification/login；
 * 受保护端点：logout/me（经 `deps.authMiddleware`）。
 */
export function createAuthRouter(deps) {
    const router = Router();
    const now = deps.now ?? (() => new Date());
    // 注册（公开）：创建待验证账号并触发验证邮件（需求 1.1–1.7）。
    router.post('/register', asyncHandler(async (req, res) => {
        const email = asString(req.body?.email);
        const password = asString(req.body?.password);
        const result = await deps.authService.register(email, password);
        const message = result.emailSendFailed
            ? REGISTER_EMAIL_FAILED_MESSAGE
            : REGISTER_OK_MESSAGE;
        // 账号已创建：发信失败用 202 表达「已受理但未完全成功」，正常用 201。
        res
            .status(result.emailSendFailed ? 202 : 201)
            .json(success({ status: result.status, emailSendFailed: result.emailSendFailed }, message));
    }));
    // 邮箱验证（公开）：校验令牌并激活账号（需求 1.9, 1.10）。
    router.get('/verify-email', asyncHandler(async (req, res) => {
        const token = asString(req.query.token);
        if (!token) {
            throw new HttpError(ErrorCode.VerificationInvalid, VERIFY_INVALID_MESSAGE);
        }
        const result = await deps.emailVerificationService.validate(token, now());
        if ('error' in result) {
            if (result.error === 'EXPIRED') {
                throw new HttpError(ErrorCode.VerificationExpired, VERIFY_EXPIRED_MESSAGE);
            }
            throw new HttpError(ErrorCode.VerificationInvalid, VERIFY_INVALID_MESSAGE);
        }
        await deps.accountGateway.activate(result.userId);
        res.json(success({ verified: true }, VERIFY_OK_MESSAGE));
    }));
    // 重发验证邮件（公开）：对「待验证」账号使旧令牌失效并重发（需求 1.11）。
    // 无论账号是否存在/是否待验证都返回相同信封，避免邮箱枚举。
    router.post('/resend-verification', asyncHandler(async (req, res) => {
        const email = asString(req.body?.email);
        const userId = await deps.accountGateway.findPendingUserIdByEmail(email);
        if (userId) {
            await deps.emailVerificationService.invalidateExisting(userId);
            await deps.emailVerificationService.issue(userId);
        }
        res.json(success({ resent: true }, RESEND_OK_MESSAGE));
    }));
    // 登录（公开）：仅已激活账号可登录，返回 token+role（需求 1.12–1.14, 2.1）。
    router.post('/login', asyncHandler(async (req, res) => {
        const email = asString(req.body?.email);
        const password = asString(req.body?.password);
        const result = await deps.authService.login(email, password);
        res.json(success({ token: result.token, role: result.role }, LOGIN_OK_MESSAGE));
    }));
    // 登出（需认证）：立即终止当前会话（需求 2.5）。
    router.post('/logout', deps.authMiddleware, asyncHandler(async (req, res) => {
        // authMiddleware 已保证 req.user 存在。
        await deps.authService.logout(req.user.sessionId);
        res.json(success({ loggedOut: true }, LOGOUT_OK_MESSAGE));
    }));
    // 当前用户（需认证）：会话活跃时间已由认证中间件刷新（需求 2.2）。
    router.get('/me', deps.authMiddleware, asyncHandler(async (req, res) => {
        const user = req.user;
        res.json(success({ userId: user.userId, role: user.role }));
    }));
    return router;
}
/**
 * 构造生产默认 `/auth` 路由：Drizzle 持久化 + SES 发信 + 基于 `JWT_SECRET` 的
 * 认证中间件。所有默认实现构造均无副作用（数据库/SES 连接惰性建立）。
 */
export function buildDefaultAuthRouter() {
    const mailer = new SesMailer();
    const emailVerificationService = new EmailVerificationService({
        mailer,
        verifyUrlBase: process.env.VERIFY_URL_BASE,
    });
    const authService = new AuthService({ emailVerificationService });
    const accountGateway = new DrizzleAccountGateway();
    const authMiddleware = createAuthMiddleware();
    return createAuthRouter({
        authService,
        emailVerificationService,
        accountGateway,
        authMiddleware,
    });
}
