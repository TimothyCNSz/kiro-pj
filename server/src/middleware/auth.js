// 认证中间件与管理员 Guard（需求 1.15, 2.4, 3.1–3.4, 20.1, 20.3, 20.4）。
//
// 职责（见设计「认证与会话流程」「角色与授权流程」「安全模型」）：
//   - authMiddleware：从 `Authorization: Bearer <token>` 提取并校验 JWT（HS256，
//     密钥来自 `JWT_SECRET`）。JWT 仅携带 `{ sub, sid, role }`；会话空闲有效性由
//     服务端权威判定——经 `SessionManager.validateAndTouch(sid, now)` 校验并在
//     有效时顺延 `lastActiveAt`（需求 2.2）。缺失/非法 token、会话已撤销或空闲过期
//     一律拒绝为 401 `UNAUTHENTICATED`（需求 1.15, 2.4, 20.1, 20.3）。通过后把
//     `{ userId, role, sessionId }` 附加到 `req.user` 供下游路由/守卫使用。
//   - adminGuard：要求 `req.user.role === admin`，否则 403 `FORBIDDEN`
//     （需求 3.3, 3.4, 20.4）。必须挂在 authMiddleware 之后；缺少 `req.user`（未经
//     认证）则回退为 401，保持「未登录先于越权」的语义。
//
// 所有外部依赖（JWT 校验器、会话管理器、时钟）均可注入，便于用替身做 Supertest
// 中间件测试而不触达真实数据库/密钥。
//
// Requirements: 1.15, 2.4, 3.1, 3.2, 3.3, 3.4, 20.1, 20.3, 20.4.
import jwt from 'jsonwebtoken';
import { Role, isRole } from '../lib/domain';
import { ErrorCode } from '../lib/errors';
import { DrizzleSessionService } from '../services/session-service';
import { HttpError } from './http-error';
/** 未认证的统一提示（需求 1.15, 2.4, 20.1, 20.3）。 */
export const UNAUTHENTICATED_MESSAGE = '未登录或会话已过期，请重新登录';
/** 无管理员权限的统一提示（需求 3.3, 3.4, 20.4）。 */
export const FORBIDDEN_MESSAGE = '无权限访问该资源';
/** 基于 `jsonwebtoken` 的默认校验实现（HS256，密钥取自 `JWT_SECRET`）。 */
export class JwtHs256Verifier {
    secret;
    constructor(options = {}) {
        this.secret = options.secret ?? process.env.JWT_SECRET ?? '';
    }
    verify(token) {
        if (!this.secret) {
            throw new Error('JWT_SECRET is not set. A verification secret is required to authenticate requests.');
        }
        try {
            const decoded = jwt.verify(token, this.secret);
            if (typeof decoded !== 'object' || decoded === null)
                return null;
            const { sub, sid, role } = decoded;
            if (typeof sub !== 'string' || typeof sid !== 'string' || !isRole(role)) {
                return null;
            }
            return { sub, sid, role };
        }
        catch {
            // 签名无效 / 过期 / 结构非法：一律视为未认证。
            return null;
        }
    }
}
const BEARER_PREFIX = 'Bearer ';
/** 从 `Authorization` 头提取 Bearer token；缺失/格式错误返回 null。 */
function extractBearerToken(header) {
    if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX))
        return null;
    const token = header.slice(BEARER_PREFIX.length).trim();
    return token.length > 0 ? token : null;
}
/**
 * 创建认证中间件：校验 JWT → 服务端会话空闲校验并刷新 → 附加 `req.user`。
 *
 * 任一环节失败（无 token / token 非法 / 会话撤销或空闲过期）均以
 * `HttpError(UNAUTHENTICATED)` 交由统一错误中间件序列化为 401
 * （需求 1.15, 2.4, 20.1, 20.3）。
 */
export function createAuthMiddleware(options = {}) {
    const verifier = options.verifier ?? new JwtHs256Verifier();
    const sessionManager = options.sessionManager ?? new DrizzleSessionService();
    const now = options.now ?? (() => new Date());
    return (req, _res, next) => {
        // Express 4 不会捕获异步中间件的 rejection，故内部自行 catch 并转交 next(err)。
        void (async () => {
            try {
                const token = extractBearerToken(req.headers.authorization);
                if (!token) {
                    throw new HttpError(ErrorCode.Unauthenticated, UNAUTHENTICATED_MESSAGE);
                }
                const payload = verifier.verify(token);
                if (!payload) {
                    throw new HttpError(ErrorCode.Unauthenticated, UNAUTHENTICATED_MESSAGE);
                }
                // 会话空闲有效性以服务端为准：有效则刷新活跃时间，无效/不存在则拒绝。
                const session = await sessionManager.validateAndTouch(payload.sid, now());
                if (!session) {
                    throw new HttpError(ErrorCode.Unauthenticated, UNAUTHENTICATED_MESSAGE);
                }
                req.user = { userId: payload.sub, role: payload.role, sessionId: payload.sid };
                next();
            }
            catch (err) {
                next(err);
            }
        })();
    };
}
/**
 * 管理员 Guard：要求当前请求主体为管理员（需求 3.3, 3.4, 20.4）。
 * 须挂在 {@link createAuthMiddleware} 之后；缺少 `req.user` 回退为 401。
 */
export const adminGuard = (req, _res, next) => {
    const user = req.user;
    if (!user) {
        // 未经认证（未挂认证中间件或认证未通过）：先于越权返回未认证。
        next(new HttpError(ErrorCode.Unauthenticated, UNAUTHENTICATED_MESSAGE));
        return;
    }
    if (user.role !== Role.Admin) {
        next(new HttpError(ErrorCode.Forbidden, FORBIDDEN_MESSAGE));
        return;
    }
    next();
};
