// Shared domain types for AWSomeShop.
//
// These string-literal unions mirror the enum columns defined in the design
// Data Models section. They are the single source of truth shared between the
// backend services, persistence layer, and (conceptually) the frontend
// contract. Each type ships with a `const` value map so runtime code can
// enumerate/validate members without duplicating the literals.
//
// Design refs: "Data Models · 字段定义" (User / Product / Order / CDK ...).

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

/** 用户角色（需求 1.4, 3）。注册流程创建的账号一律为 employee；admin 仅由部署种子预置。 */
export const Role = {
  Employee: 'employee',
  Admin: 'admin',
} as const
export type Role = (typeof Role)[keyof typeof Role]

/**
 * 账号状态（需求 1.3, 1.12, 1.13）。
 * - pending_verification：新注册但尚未完成邮箱验证，不允许登录。
 * - active：已完成邮箱验证，允许登录。
 */
export const AccountStatus = {
  PendingVerification: 'pending_verification',
  Active: 'active',
} as const
export type AccountStatus = (typeof AccountStatus)[keyof typeof AccountStatus]

// ---------------------------------------------------------------------------
// Product
// ---------------------------------------------------------------------------

/** 商品类型（需求 12.1）：实物 / 虚拟。 */
export const ProductType = {
  Physical: 'physical',
  Virtual: 'virtual',
} as const
export type ProductType = (typeof ProductType)[keyof typeof ProductType]

/** 商品上下架状态（需求 4.1, 4.2, 12.4）。仅 listed 对员工端可见且可兑换。 */
export const ProductStatus = {
  Listed: 'listed',
  Unlisted: 'unlisted',
} as const
export type ProductStatus = (typeof ProductStatus)[keyof typeof ProductStatus]

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

/** 订单类型（需求 7.9）。一次结算按商品类型拆分为独立的实物/虚拟订单。 */
export const OrderType = {
  Physical: 'physical',
  Virtual: 'virtual',
} as const
export type OrderType = (typeof OrderType)[keyof typeof OrderType]

/** 订单状态（需求 8.4, 9.3, 9.4, 14）：待发货 / 已发货。 */
export const OrderStatus = {
  PendingShipment: 'pending_shipment',
  Shipped: 'shipped',
} as const
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus]

// ---------------------------------------------------------------------------
// Runtime helpers
// ---------------------------------------------------------------------------

/** 全部合法角色取值。 */
export const ROLE_VALUES = Object.values(Role) as readonly Role[]
/** 全部合法账号状态取值。 */
export const ACCOUNT_STATUS_VALUES = Object.values(AccountStatus) as readonly AccountStatus[]
/** 全部合法商品类型取值。 */
export const PRODUCT_TYPE_VALUES = Object.values(ProductType) as readonly ProductType[]
/** 全部合法商品状态取值。 */
export const PRODUCT_STATUS_VALUES = Object.values(ProductStatus) as readonly ProductStatus[]
/** 全部合法订单类型取值。 */
export const ORDER_TYPE_VALUES = Object.values(OrderType) as readonly OrderType[]
/** 全部合法订单状态取值。 */
export const ORDER_STATUS_VALUES = Object.values(OrderStatus) as readonly OrderStatus[]

export const isRole = (v: unknown): v is Role => ROLE_VALUES.includes(v as Role)
export const isAccountStatus = (v: unknown): v is AccountStatus =>
  ACCOUNT_STATUS_VALUES.includes(v as AccountStatus)
export const isProductType = (v: unknown): v is ProductType =>
  PRODUCT_TYPE_VALUES.includes(v as ProductType)
export const isProductStatus = (v: unknown): v is ProductStatus =>
  PRODUCT_STATUS_VALUES.includes(v as ProductStatus)
export const isOrderType = (v: unknown): v is OrderType =>
  ORDER_TYPE_VALUES.includes(v as OrderType)
export const isOrderStatus = (v: unknown): v is OrderStatus =>
  ORDER_STATUS_VALUES.includes(v as OrderStatus)
