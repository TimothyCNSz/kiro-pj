// 演示种子数据脚本（可选运行、幂等，需求 4.1 / 5.1 / 12.1 / 12.2）。
//
// ⚠️ 仅用于演示环境，生产环境不运行。
//
// 目的：一次性预置「打开即可演示」的完整业务数据，覆盖
//   浏览 → 加购 → 兑换 → 发货
// 全流程所需的最小数据集：
//   - 若干示例商品：实物与虚拟各若干、status=上架（listed）、含 pointsCost/stock
//     及图集占位 URL；每个商品配 1~2 条 ProductImage（其一 isPrimary=true）。
//   - 虚拟商品的示例 CDK：每个虚拟商品若干 status=available 的兑换码。
//   - 1~2 个示例员工账号：status=active、role=employee、口令仅存哈希；并为每个
//     创建 PointsAccount 且给予较充足的初始积分余额，便于演示兑换。
//
// 与初始管理员种子（seed.ts，任务 20.2）分离、可独立运行：
//
//   set DATABASE_URL=postgresql://app:<password>@<rds-endpoint>:5432/awsomeshop
//   npm run seed:demo
//
// 幂等策略（重复运行不产生重复数据、不报错）：
//   - Product：products 表无 name 唯一约束，故以「稳定业务键 name 先查后插」实现
//     幂等——已存在同名商品则跳过（不覆盖其字段），仅对本次新建的商品补插图集。
//   - ProductImage：仅依附于「本次新建的商品」，避免对既有商品重复插图。
//   - CDK：cdks 表无 code 唯一约束，故以「稳定业务键 code 先查后插」实现幂等。
//   - User：以 email 唯一键 onConflictDoNothing；口令仅以哈希落库。
//   - PointsAccount：以 userId 主键 onConflictDoNothing（已存在则不重置余额）。
//
// 与 migrate.ts / seed.ts 一致，仅依赖运行时包（drizzle-orm + postgres.js），
// 可打包成 dist/seed-demo.mjs 在未安装 devDependencies 的部署环境执行。使用
// max: 1 的专用连接，结束前关闭连接，避免进程挂起。

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { AccountStatus, ProductStatus, ProductType, Role } from '../lib/domain'
import { hashPassword } from '../lib/password'
import { cdks, pointsAccounts, productImages, products, users } from './schema'

/** 占位图 CDN 基址（演示用，无需真实存在的对象）。 */
const PLACEHOLDER_MEDIA_BASE = 'https://demo.example-company.com/media'

/** 演示商品定义。virtual 商品的 stock 语义 = 可用 CDK 数（见 schema 注释），故由 cdkCodes 数量决定。 */
interface DemoProduct {
  /** 稳定业务键：以商品名判定幂等。 */
  name: string
  description: string
  pointsCost: number
  type: ProductType
  /** 实物商品的库存；虚拟商品忽略此值（由 cdkCodes.length 决定）。 */
  physicalStock?: number
  /** 图集占位对象键（第一张作主图）。 */
  imageKeys: string[]
  /** 虚拟商品的示例 CDK 码（稳定业务键，available 状态）。 */
  cdkCodes?: string[]
}

/** 演示员工定义。 */
interface DemoEmployee {
  email: string
  /** 演示初始明文口令（脚本内哈希后落库，绝不落明文）。 */
  password: string
  /** 初始积分余额：给足以完成多次兑换演示。 */
  balance: number
}

/** 示例商品清单：实物 3 个 + 虚拟 3 个，均为上架状态。 */
const DEMO_PRODUCTS: readonly DemoProduct[] = [
  {
    name: '演示定制机械键盘',
    description: '演示用实物商品：客制化机械键盘，热插拔轴体。',
    pointsCost: 800,
    type: ProductType.Physical,
    physicalStock: 25,
    imageKeys: ['demo/keyboard-1.jpg', 'demo/keyboard-2.jpg'],
  },
  {
    name: '演示品牌保温杯',
    description: '演示用实物商品：不锈钢真空保温杯，附公司 Logo。',
    pointsCost: 300,
    type: ProductType.Physical,
    physicalStock: 60,
    imageKeys: ['demo/bottle-1.jpg'],
  },
  {
    name: '演示无线降噪耳机',
    description: '演示用实物商品：主动降噪蓝牙耳机。',
    pointsCost: 1200,
    type: ProductType.Physical,
    physicalStock: 10,
    imageKeys: ['demo/headphone-1.jpg', 'demo/headphone-2.jpg'],
  },
  {
    name: '演示视频会员月卡',
    description: '演示用虚拟商品：主流视频平台会员月卡兑换码。',
    pointsCost: 200,
    type: ProductType.Virtual,
    imageKeys: ['demo/video-card-1.jpg'],
    cdkCodes: [
      'DEMO-VIDEO-0001',
      'DEMO-VIDEO-0002',
      'DEMO-VIDEO-0003',
      'DEMO-VIDEO-0004',
      'DEMO-VIDEO-0005',
    ],
  },
  {
    name: '演示云存储扩容包',
    description: '演示用虚拟商品：云存储空间扩容兑换码。',
    pointsCost: 150,
    type: ProductType.Virtual,
    imageKeys: ['demo/cloud-1.jpg', 'demo/cloud-2.jpg'],
    cdkCodes: ['DEMO-CLOUD-0001', 'DEMO-CLOUD-0002', 'DEMO-CLOUD-0003'],
  },
  {
    name: '演示咖啡电子券',
    description: '演示用虚拟商品：连锁咖啡电子兑换券。',
    pointsCost: 100,
    type: ProductType.Virtual,
    imageKeys: ['demo/coffee-1.jpg'],
    cdkCodes: ['DEMO-COFFEE-0001', 'DEMO-COFFEE-0002', 'DEMO-COFFEE-0003', 'DEMO-COFFEE-0004'],
  },
]

/** 示例员工清单：2 个 active 账号，积分充足。 */
const DEMO_EMPLOYEES: readonly DemoEmployee[] = [
  { email: 'demo.employee1@example-company.com', password: 'DemoPass!123', balance: 5000 },
  { email: 'demo.employee2@example-company.com', password: 'DemoPass!456', balance: 3000 },
]

type Db = PostgresJsDatabase<Record<string, never>>

/**
 * 幂等预置单个演示商品及其图集与 CDK。
 *
 * 以商品名 name 为稳定业务键先查后插：
 *   - 若同名商品已存在：跳过商品与图集创建（不覆盖既有字段），仅补齐缺失的 CDK。
 *   - 若不存在：插入商品（listed）、其图集（第一张 isPrimary），随后补齐 CDK。
 *
 * @returns 该商品的 id。
 */
async function ensureDemoProduct(db: Db, def: DemoProduct): Promise<string> {
  const existing = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.name, def.name))
    .limit(1)

  const isVirtual = def.type === ProductType.Virtual
  // 虚拟商品库存 = 可用 CDK 数（schema 注释：virtual 的 stock 为派生值）。
  const stock = isVirtual ? (def.cdkCodes?.length ?? 0) : (def.physicalStock ?? 0)
  const primaryKey = def.imageKeys[0]
  const primaryUrl = `${PLACEHOLDER_MEDIA_BASE}/${primaryKey}`

  let productId = existing[0]?.id
  if (!productId) {
    const inserted = await db
      .insert(products)
      .values({
        name: def.name,
        description: def.description,
        // 冗余缓存的主图 URL，供列表视图直接使用。
        imageUrl: primaryUrl,
        pointsCost: def.pointsCost,
        type: def.type,
        status: ProductStatus.Listed,
        stock,
      })
      .returning({ id: products.id })
    productId = inserted[0]!.id

    // 仅对本次新建的商品插入图集，避免对既有商品重复插图。
    await db.insert(productImages).values(
      def.imageKeys.map((key, index) => ({
        productId: productId!,
        objectKey: key,
        url: `${PLACEHOLDER_MEDIA_BASE}/${key}`,
        isPrimary: index === 0,
        sortOrder: index,
      })),
    )
    console.log(`[seed:demo] product created: name=${def.name}, type=${def.type}, stock=${stock}`)
  } else {
    console.log(`[seed:demo] product exists, skip: name=${def.name}`)
  }

  // 补齐虚拟商品的示例 CDK（以 code 为稳定业务键先查后插）。
  if (def.cdkCodes && def.cdkCodes.length > 0) {
    await ensureDemoCdks(db, productId, def.cdkCodes)
  }

  return productId
}

/**
 * 幂等预置某商品的示例 CDK：cdks 表无 code 唯一约束，故以 (productId, code)
 * 先查后插——已存在则跳过，不存在才插入 status=available 的记录。
 */
async function ensureDemoCdks(db: Db, productId: string, codes: readonly string[]): Promise<void> {
  for (const code of codes) {
    const existing = await db
      .select({ id: cdks.id })
      .from(cdks)
      .where(and(eq(cdks.productId, productId), eq(cdks.code, code)))
      .limit(1)
    if (existing[0]) continue
    await db.insert(cdks).values({ productId, code, status: 'available' })
  }
}

/**
 * 幂等预置单个演示员工：以 email 唯一键 onConflictDoNothing 插入 active/employee
 * 用户，口令仅以哈希落库；并确保其 PointsAccount 存在且拥有充足初始余额。
 */
async function ensureDemoEmployee(db: Db, def: DemoEmployee): Promise<void> {
  const passwordHash = hashPassword(def.password)
  const inserted = await db
    .insert(users)
    .values({
      email: def.email,
      passwordHash,
      role: Role.Employee,
      status: AccountStatus.Active,
    })
    .onConflictDoNothing({ target: users.email })
    .returning({ id: users.id })

  // 命中冲突时不返回行：回查既有用户 id。
  let userId = inserted[0]?.id
  if (!userId) {
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, def.email))
      .limit(1)
    userId = existing[0]?.id
  }
  if (!userId) {
    throw new Error(`failed to resolve demo employee id for email ${def.email}`)
  }

  // 幂等创建积分账户：已存在则不重置余额（保持重复运行的稳定性）。
  await db
    .insert(pointsAccounts)
    .values({ userId, balance: def.balance })
    .onConflictDoNothing({ target: pointsAccounts.userId })

  console.log(`[seed:demo] employee ensured: email=${def.email}, balance=${def.balance}`)
}

/**
 * 幂等预置全部演示数据（商品 + 图集 + CDK + 员工 + 积分账户）。
 *
 * @param databaseUrl 目标数据库连接串。
 */
export async function seedDemoData(databaseUrl: string): Promise<void> {
  // 专用种子连接：单连接，无需连接池。
  const sql = postgres(databaseUrl, { max: 1 })
  try {
    const db = drizzle(sql)

    for (const def of DEMO_PRODUCTS) {
      await ensureDemoProduct(db, def)
    }
    for (const def of DEMO_EMPLOYEES) {
      await ensureDemoEmployee(db, def)
    }

    console.log(
      `[seed:demo] demo data ensured: products=${DEMO_PRODUCTS.length}, employees=${DEMO_EMPLOYEES.length}`,
    )
  } finally {
    // 始终释放连接，确保种子进程可退出。
    await sql.end({ timeout: 5 })
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('[seed:demo] DATABASE_URL is not set; aborting.')
    process.exit(1)
  }

  console.log('[seed:demo] seeding demo data (idempotent, demo-only) ...')
  await seedDemoData(databaseUrl)
  console.log('[seed:demo] done.')
}

// 仅在被直接执行时运行（被测试 import 时不触发）。
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error('[seed:demo] seeding failed:', err)
    process.exit(1)
  })
}
