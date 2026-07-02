// Pure, injectable validation utilities for AWSomeShop.
//
// These helpers implement the registration validation rules from the design
// "认证与会话流程" / requirements 1.1, 1.2, 1.7. They are intentionally pure
// (no I/O, no module-level env reads inside the core functions) so they are
// trivially unit- and property-testable and can later be reused by
// AuthService (task 3.7) and the presign/route layers.
//
// Requirement refs:
//   - 1.1 密码强度：长度 ≥ 8 且至少同时包含字母与数字各一。
//   - 1.2 允许注册的邮箱限定为公司邮箱域名下的邮箱。
//   - 1.7 非公司邮箱域名不允许注册。
// ---------------------------------------------------------------------------
// Password strength (需求 1.1)
// ---------------------------------------------------------------------------
/** 密码最小长度（需求 1.1）。 */
export const MIN_PASSWORD_LENGTH = 8;
/**
 * 校验密码强度（需求 1.1）。
 *
 * 规则：长度 ≥ 8，且至少各包含一个字母（A–Z / a–z）与一个数字（0–9）。
 * 纯函数，不做任何副作用。
 *
 * @param password 待校验的明文密码。
 * @returns 满足全部规则返回 `true`，否则 `false`。
 */
export function validatePassword(password) {
    if (typeof password !== 'string')
        return false;
    if (password.length < MIN_PASSWORD_LENGTH)
        return false;
    const hasLetter = /[A-Za-z]/.test(password);
    const hasDigit = /[0-9]/.test(password);
    return hasLetter && hasDigit;
}
// ---------------------------------------------------------------------------
// Email domain allowlist (需求 1.2, 1.7)
// ---------------------------------------------------------------------------
/**
 * 从邮箱字符串中解析出小写、去空白的域名部分。
 *
 * 仅接受形如 `local@domain` 且恰有一个 `@`、本地部分与域名部分均非空的邮箱；
 * 其它输入（无 `@`、多个 `@`、空段）返回 `null`。域名统一转为小写便于大小写不敏感比较。
 *
 * @param email 待解析的邮箱字符串。
 * @returns 规范化后的域名，或非法输入时返回 `null`。
 */
export function parseEmailDomain(email) {
    if (typeof email !== 'string')
        return null;
    const trimmed = email.trim();
    const atCount = (trimmed.match(/@/g) ?? []).length;
    if (atCount !== 1)
        return null;
    const [local, domain] = trimmed.split('@');
    if (!local || !domain)
        return null;
    const normalizedDomain = domain.trim().toLowerCase();
    if (normalizedDomain.length === 0)
        return null;
    return normalizedDomain;
}
/**
 * 将逗号分隔的域名白名单字符串（如 `COMPANY_EMAIL_DOMAINS` 环境变量）解析为
 * 规范化（小写、去空白、去空项）的域名数组。
 *
 * @param raw 原始白名单字符串，可为 `undefined`。
 * @returns 规范化后的域名数组；输入为空/未定义时返回空数组。
 */
export function parseCompanyEmailDomains(raw) {
    if (!raw)
        return [];
    return raw
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter((d) => d.length > 0);
}
/**
 * 从环境变量 `COMPANY_EMAIL_DOMAINS` 读取并解析公司邮箱域名白名单。
 *
 * 提供给运行时代码作为 `validateEmailDomain` 的默认白名单来源；测试可直接调用
 * `validateEmailDomain(email, [...])` 传入显式白名单以保持纯度。
 */
export function getCompanyEmailDomains() {
    return parseCompanyEmailDomains(process.env.COMPANY_EMAIL_DOMAINS);
}
/**
 * 校验邮箱域名是否属于公司邮箱白名单（需求 1.2, 1.7）。
 *
 * 白名单可注入（作为参数传入），默认从环境变量读取，便于单元/属性测试。
 * 比较大小写不敏感。当邮箱非法（无法解析域名）或白名单为空时返回 `false`。
 *
 * @param email 待校验的邮箱。
 * @param allowlist 允许的公司域名白名单；默认取自 `COMPANY_EMAIL_DOMAINS`。
 * @returns 域名命中白名单返回 `true`，否则 `false`。
 */
export function validateEmailDomain(email, allowlist = getCompanyEmailDomains()) {
    const domain = parseEmailDomain(email);
    if (domain === null)
        return false;
    const normalized = allowlist.map((d) => d.trim().toLowerCase()).filter((d) => d.length > 0);
    return normalized.includes(domain);
}
