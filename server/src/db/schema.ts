// Drizzle ORM schema for AWSomeShop (PostgreSQL / postgres.js).
//
// This module defines the full persistence schema for the MVP: users & auth,
// email verification, sessions, points, catalog (products / images / CDKs),
// server-side cart, redemption orders, points ledger, operation logs, and
// low-stock alerts.
//
// Invariants enforced at the database layer (the last line of defense, see
// design "Data Models · 字段定义" and "并发控制"):
//   - CHECK (balance    >= 0)  — points balance never negative (需求 10.3, 13.3)
//   - CHECK (stock       >= 0) — product stock never negative (需求 12.5, 5.1)
//   - CHECK (points_cost >= 0) — product points cost non-negative (需求 12.5)
//   - CHECK (quantity   >= 1)  — cart line quantity at least one
//   - `version` optimistic-lock columns on PointsAccount & Product (需求 7.10, 19.4)
//   - UNIQUE (User.email), UNIQUE (Cart.userId), UNIQUE (LowStockAlert.productId)
//   - partial UNIQUE (ProductImage.productId) WHERE is_primary = true (需求 12.8)
//
// Enum columns reuse the shared domain literal values (server/src/lib/domain.ts)
// so the persistence layer, services, and frontend contract stay in sync.

import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

import {
  ACCOUNT_STATUS_VALUES,
  ORDER_STATUS_VALUES,
  ORDER_TYPE_VALUES,
  PRODUCT_STATUS_VALUES,
  PRODUCT_TYPE_VALUES,
  ROLE_VALUES,
} from '../lib/domain'

// ---------------------------------------------------------------------------
// Enums — shared domain literals are reused; enums with no shared type are
// declared inline against the design Data Models section.
// ---------------------------------------------------------------------------

/** cast helper: pgEnum requires a non-empty string literal tuple. */
const asEnumValues = (values: readonly string[]) => values as [string, ...string[]]

export const roleEnum = pgEnum('role', asEnumValues(ROLE_VALUES))
export const accountStatusEnum = pgEnum('account_status', asEnumValues(ACCOUNT_STATUS_VALUES))
export const productTypeEnum = pgEnum('product_type', asEnumValues(PRODUCT_TYPE_VALUES))
export const productStatusEnum = pgEnum('product_status', asEnumValues(PRODUCT_STATUS_VALUES))
export const orderTypeEnum = pgEnum('order_type', asEnumValues(ORDER_TYPE_VALUES))
export const orderStatusEnum = pgEnum('order_status', asEnumValues(ORDER_STATUS_VALUES))

/** CDK lifecycle (需求 9.2, 9.3): available → consumed → delivered. */
export const cdkStatusEnum = pgEnum('cdk_status', ['available', 'consumed', 'delivered'])

/** Points ledger reason (需求 13.5, 13.6). */
export const pointsReasonEnum = pgEnum('points_reason', [
  'redemption',
  'admin_grant',
  'admin_deduct',
])

/** Operation log action types (需求 16.1). */
export const operationActionEnum = pgEnum('operation_action', [
  'product_create',
  'product_update',
  'product_status',
  'points_grant',
  'points_deduct',
  'ship_physical',
  'ship_virtual',
])

// ---------------------------------------------------------------------------
// User & auth
// ---------------------------------------------------------------------------

/** User（用户，需求 1, 3, 23）。email 唯一；仅 active 账号可登录。 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 320 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    role: roleEnum('role').notNull().default('employee'),
    status: accountStatusEnum('status').notNull().default('pending_verification'),
    // Optional employee avatar; null falls back to a default avatar (需求 23.1, 23.2).
    avatarUrl: text('avatar_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_unique').on(t.email)],
)

/** EmailVerification（邮箱验证令牌，需求 1.4, 1.8–1.11）。仅存令牌哈希。 */
export const emailVerifications = pgTable(
  'email_verifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('email_verifications_token_hash_idx').on(t.tokenHash)],
)

/** Session（会话，需求 2）。服务端权威空闲态，支撑无状态 Lambda。 */
export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
})

/** PointsAccount（积分账户，需求 10.3, 13.3）。balance >= 0；version 乐观锁。 */
export const pointsAccounts = pgTable(
  'points_accounts',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id),
    balance: integer('balance').notNull().default(0),
    version: integer('version').notNull().default(0),
  },
  () => [check('points_accounts_balance_non_negative', sql`balance >= 0`)],
)

// ---------------------------------------------------------------------------
// Catalog: Product / ProductImage / CDK
// ---------------------------------------------------------------------------

/** Product（商品，需求 4, 12）。pointsCost/stock 非负；version 乐观锁。 */
export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    // Redundant cached primary-image URL for list views (design note); nullable.
    imageUrl: text('image_url'),
    description: text('description').notNull().default(''),
    pointsCost: integer('points_cost').notNull(),
    type: productTypeEnum('type').notNull(),
    status: productStatusEnum('status').notNull().default('unlisted'),
    // For virtual products stock is a derived value (= available CDK count).
    stock: integer('stock').notNull().default(0),
    version: integer('version').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check('products_points_cost_non_negative', sql`points_cost >= 0`),
    check('products_stock_non_negative', sql`stock >= 0`),
  ],
)

/** ProductImage（商品图集，需求 4.5, 12.7–12.9, 22）。至多一张主图（部分唯一索引）。 */
export const productImages = pgTable(
  'product_images',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    objectKey: text('object_key').notNull(),
    url: text('url').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 同一商品至多一张主图（需求 12.8, 12.9）：部分唯一索引仅约束 is_primary = true 行。
    uniqueIndex('product_images_primary_unique')
      .on(t.productId)
      .where(sql`${t.isPrimary} = true`),
  ],
)

/** CDK（虚拟兑换码，需求 5.1, 9, 12.2）。可用 CDK 数即虚拟商品可兑换库存。 */
export const cdks = pgTable('cdks', {
  id: uuid('id').primaryKey().defaultRandom(),
  productId: uuid('product_id')
    .notNull()
    .references(() => products.id),
  code: text('code').notNull(),
  status: cdkStatusEnum('status').notNull().default('available'),
  orderId: uuid('order_id'),
})

// ---------------------------------------------------------------------------
// Cart / CartItem (server-side, 需求 6.6)
// ---------------------------------------------------------------------------

/** Cart（购物车，需求 6.6）。userId 唯一：每员工至多一个购物车。 */
export const carts = pgTable(
  'carts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
  },
  (t) => [uniqueIndex('carts_user_id_unique').on(t.userId)],
)

/** CartItem（购物车条目，需求 6）。quantity >= 1。 */
export const cartItems = pgTable(
  'cart_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cartId: uuid('cart_id')
      .notNull()
      .references(() => carts.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    quantity: integer('quantity').notNull(),
  },
  () => [check('cart_items_quantity_positive', sql`quantity >= 1`)],
)

// ---------------------------------------------------------------------------
// Order / OrderItem (需求 7, 8, 9, 11)
// ---------------------------------------------------------------------------

/** Order（兑换订单，需求 7, 8, 9, 11）。按类型拆分为实物/虚拟订单。 */
export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  type: orderTypeEnum('type').notNull(),
  pointsSpent: integer('points_spent').notNull(),
  status: orderStatusEnum('status').notNull().default('pending_shipment'),
  // Physical orders persist the delivery address (需求 8.1).
  shippingAddress: jsonb('shipping_address'),
  trackingNo: text('tracking_no'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** OrderItem（订单项，需求 7, 11）。下单时快照商品名与单价，历史稳定展示。 */
export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    productName: varchar('product_name', { length: 255 }).notNull(),
    quantity: integer('quantity').notNull(),
    unitPoints: integer('unit_points').notNull(),
  },
  () => [check('order_items_quantity_positive', sql`quantity >= 1`)],
)

// ---------------------------------------------------------------------------
// PointsLedger / OperationLog / LowStockAlert
// ---------------------------------------------------------------------------

/** PointsLedger（积分流水，需求 13.6, 20.2）。余额 = 初始 + Σ(delta)。 */
export const pointsLedger = pgTable('points_ledger', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  delta: integer('delta').notNull(),
  reason: pointsReasonEnum('reason').notNull(),
  note: text('note'),
  balanceAfter: integer('balance_after').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** OperationLog（操作日志，需求 16）。时间倒序展示。 */
export const operationLogs = pgTable('operation_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorId: uuid('actor_id')
    .notNull()
    .references(() => users.id),
  action: operationActionEnum('action').notNull(),
  targetType: varchar('target_type', { length: 64 }).notNull(),
  targetId: uuid('target_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** LowStockAlert（低库存提醒，需求 5.3, 15）。productId 唯一：去重、不重复触发。 */
export const lowStockAlerts = pgTable(
  'low_stock_alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    triggeredAt: timestamp('triggered_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('low_stock_alerts_product_id_unique').on(t.productId)],
)

// ---------------------------------------------------------------------------
// Inferred row types (select / insert) for use across the backend.
// ---------------------------------------------------------------------------

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type EmailVerification = typeof emailVerifications.$inferSelect
export type NewEmailVerification = typeof emailVerifications.$inferInsert
export type Session = typeof sessions.$inferSelect
export type NewSession = typeof sessions.$inferInsert
export type PointsAccount = typeof pointsAccounts.$inferSelect
export type NewPointsAccount = typeof pointsAccounts.$inferInsert
export type Product = typeof products.$inferSelect
export type NewProduct = typeof products.$inferInsert
export type ProductImage = typeof productImages.$inferSelect
export type NewProductImage = typeof productImages.$inferInsert
export type Cdk = typeof cdks.$inferSelect
export type NewCdk = typeof cdks.$inferInsert
export type Cart = typeof carts.$inferSelect
export type NewCart = typeof carts.$inferInsert
export type CartItem = typeof cartItems.$inferSelect
export type NewCartItem = typeof cartItems.$inferInsert
export type Order = typeof orders.$inferSelect
export type NewOrder = typeof orders.$inferInsert
export type OrderItem = typeof orderItems.$inferSelect
export type NewOrderItem = typeof orderItems.$inferInsert
export type PointsLedgerEntry = typeof pointsLedger.$inferSelect
export type NewPointsLedgerEntry = typeof pointsLedger.$inferInsert
export type OperationLog = typeof operationLogs.$inferSelect
export type NewOperationLog = typeof operationLogs.$inferInsert
export type LowStockAlert = typeof lowStockAlerts.$inferSelect
export type NewLowStockAlert = typeof lowStockAlerts.$inferInsert
