// 初始管理员种子脚本（一次性、幂等，需求 3.5–3.7）。
//
// 由于系统不提供管理员自助注册与应用内提权，首个（初始）管理员账号必须在部署
// 阶段由一次性 seed 脚本预置（见设计「部署与自动化 · 数据库种子」）。本脚本在
// DB 迁移完成之后、后端上线之前执行一次即可：
//
//   set DATABASE_URL=postgresql://app:<password>@<rds-endpoint>:5432/awsomeshop
//   set SEED_ADMIN_EMAIL=admin@example-company.com
//   set SEED_ADMIN_PASSWORD=<一次性初始口令>
//   npm run seed
//
// 动作：
//   - 读取 SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD（缺失则报错退出）。
//   - 口令仅以哈希形式落库（hashPassword，与登录一致）；明文绝不入库。
//   - 以 email 唯一键幂等 upsert 一个 role=admin、status=active 的 User
//     （onConflictDoNothing），并为其创建 PointsAccount(balance=0)（按 userId
//     幂等，onConflictDoNothing）。
//   - 重复运行不产生第二个种子管理员、不报错；若同邮箱账号已存在则跳过创建、
//     不覆盖既有口令，仅确保其积分账户存在。
//
// 与 migrate.ts 一致，仅依赖运行时包（drizzle-orm + postgres.js），可打包成
// dist/seed.mjs 在未安装 devDependencies 的部署环境执行。使用 max: 1 的专用连接，
// 结束前关闭连接，避免进程挂起。

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { Role, AccountStatus } from '../lib/domain'
import { hashPassword } from '../lib/password'
import { pointsAccounts, users } from './schema'

/**
 * 幂等预置初始管理员：以 email 唯一键 upsert（onConflictDoNothing）一个
 * admin/active 用户，并确保其 PointsAccount(balance=0) 存在。
 *
 * @param databaseUrl 目标数据库连接串。
 * @param email 种子管理员邮箱（唯一键）。
 * @param password 种子管理员初始明文口令（脚本内哈希后落库，不落明文）。
 */
export async function seedInitialAdmin(
  databaseUrl: string,
  email: string,
  password: string,
): Promise<void> {
  // 专用种子连接：单连接，无需连接池。
  const sql = postgres(databaseUrl, { max: 1 })
  try {
    const db = drizzle(sql)
    const passwordHash = hashPassword(password)

    // 以 email 唯一键幂等插入管理员用户；若已存在则不覆盖既有口令/角色。
    const inserted = await db
      .insert(users)
      .values({
        email,
        passwordHash,
        role: Role.Admin,
        status: AccountStatus.Active,
      })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id })

    // onConflictDoNothing 命中冲突时不返回行：回查既有用户 id，确保后续关联正确。
    let userId = inserted[0]?.id
    if (!userId) {
      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1)
      userId = existing[0]?.id
    }

    if (!userId) {
      // 理论上不可达：既非新插入也非既有用户。抛错让调用方以非零码退出。
      throw new Error(`failed to resolve seeded admin user id for email ${email}`)
    }

    // 幂等创建积分账户（userId 为主键）：已存在则跳过，不重置余额。
    await db
      .insert(pointsAccounts)
      .values({ userId, balance: 0 })
      .onConflictDoNothing({ target: pointsAccounts.userId })

    console.log(
      `[seed] initial admin ensured: email=${email}, role=${Role.Admin}, status=${AccountStatus.Active}`,
    )
  } finally {
    // 始终释放连接，确保种子进程可退出。
    await sql.end({ timeout: 5 })
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('[seed] DATABASE_URL is not set; aborting.')
    process.exit(1)
  }

  const email = process.env.SEED_ADMIN_EMAIL
  const password = process.env.SEED_ADMIN_PASSWORD
  if (!email || !password) {
    console.error(
      '[seed] SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must both be set; aborting.',
    )
    process.exit(1)
  }

  console.log('[seed] seeding initial admin (idempotent) ...')
  await seedInitialAdmin(databaseUrl, email, password)
  console.log('[seed] done.')
}

// 仅在被直接执行时运行（被测试 import 时不触发）。
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error('[seed] seeding failed:', err)
    process.exit(1)
  })
}
