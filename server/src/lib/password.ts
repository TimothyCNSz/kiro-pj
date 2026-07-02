// Password hashing utilities for AWSomeShop (需求 1.12–1.14, 3.5/20.x)。
//
// 口令仅以哈希形式存储与比对，明文绝不落库（设计「认证与会话流程」、需求 1.14）。
// 由于工程未引入 bcrypt/argon2 原生依赖，这里采用 Node 内置 `node:crypto` 的
// scrypt（内存/CPU 硬化的 KDF）配合随机盐，并以 `timingSafeEqual` 做常量时间比对，
// 避免时序侧信道。哈希串自描述其参数，便于日后平滑调整成本或迁移算法：
//
//   scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>
//
// 纯函数（除随机盐外无副作用、无 I/O），便于单元/属性测试注入固定盐。

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/** scrypt 成本参数（演示级：安全与速度的平衡）。 */
export const SCRYPT_PARAMS = {
  /** CPU/内存成本，必须为 2 的幂。 */
  N: 16384,
  /** 块大小。 */
  r: 8,
  /** 并行度。 */
  p: 1,
  /** 派生密钥长度（字节）。 */
  keylen: 64,
} as const

const SALT_BYTES = 16
const ALGO_TAG = 'scrypt'

/**
 * 计算口令哈希，返回自描述的哈希串（含算法、参数、盐与派生值）。
 *
 * @param password 明文口令。
 * @param salt 可选盐（十六进制串）；缺省随机生成，便于测试注入确定盐。
 * @returns 形如 `scrypt$N$r$p$saltHex$hashHex` 的哈希串。
 */
export function hashPassword(password: string, salt?: string): string {
  const saltHex = salt ?? randomBytes(SALT_BYTES).toString('hex')
  const { N, r, p, keylen } = SCRYPT_PARAMS
  const derived = scryptSync(password, saltHex, keylen, { N, r, p })
  return [ALGO_TAG, N, r, p, saltHex, derived.toString('hex')].join('$')
}

/**
 * 常量时间比对明文口令与存储哈希串。
 *
 * 解析哈希串中的参数与盐后重新派生并比较；串格式非法或算法不符时返回 `false`，
 * 绝不抛出，便于登录路径统一处理为「凭据错误」。
 *
 * @param password 待校验的明文口令。
 * @param stored `hashPassword` 产出的哈希串。
 * @returns 匹配返回 `true`，否则 `false`。
 */
export function verifyPassword(password: string, stored: string): boolean {
  if (typeof password !== 'string' || typeof stored !== 'string') return false
  const parts = stored.split('$')
  if (parts.length !== 6) return false
  const [tag, nStr, rStr, pStr, saltHex, hashHex] = parts
  if (tag !== ALGO_TAG) return false

  const N = Number(nStr)
  const r = Number(rStr)
  const p = Number(pStr)
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false

  let expected: Buffer
  try {
    expected = Buffer.from(hashHex, 'hex')
    if (expected.length === 0) return false
    const derived = scryptSync(password, saltHex, expected.length, { N, r, p })
    if (derived.length !== expected.length) return false
    return timingSafeEqual(derived, expected)
  } catch {
    return false
  }
}
