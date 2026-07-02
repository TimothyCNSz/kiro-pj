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
};
/**
 * 账号状态（需求 1.3, 1.12, 1.13）。
 * - pending_verification：新注册但尚未完成邮箱验证，不允许登录。
 * - active：已完成邮箱验证，允许登录。
 */
export const AccountStatus = {
    PendingVerification: 'pending_verification',
    Active: 'active',
};
// ---------------------------------------------------------------------------
// Product
// ---------------------------------------------------------------------------
/** 商品类型（需求 12.1）：实物 / 虚拟。 */
export const ProductType = {
    Physical: 'physical',
    Virtual: 'virtual',
};
/** 商品上下架状态（需求 4.1, 4.2, 12.4）。仅 listed 对员工端可见且可兑换。 */
export const ProductStatus = {
    Listed: 'listed',
    Unlisted: 'unlisted',
};
// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------
/** 订单类型（需求 7.9）。一次结算按商品类型拆分为独立的实物/虚拟订单。 */
export const OrderType = {
    Physical: 'physical',
    Virtual: 'virtual',
};
/** 订单状态（需求 8.4, 9.3, 9.4, 14）：待发货 / 已发货。 */
export const OrderStatus = {
    PendingShipment: 'pending_shipment',
    Shipped: 'shipped',
};
// ---------------------------------------------------------------------------
// Runtime helpers
// ---------------------------------------------------------------------------
/** 全部合法角色取值。 */
export const ROLE_VALUES = Object.values(Role);
/** 全部合法账号状态取值。 */
export const ACCOUNT_STATUS_VALUES = Object.values(AccountStatus);
/** 全部合法商品类型取值。 */
export const PRODUCT_TYPE_VALUES = Object.values(ProductType);
/** 全部合法商品状态取值。 */
export const PRODUCT_STATUS_VALUES = Object.values(ProductStatus);
/** 全部合法订单类型取值。 */
export const ORDER_TYPE_VALUES = Object.values(OrderType);
/** 全部合法订单状态取值。 */
export const ORDER_STATUS_VALUES = Object.values(OrderStatus);
export const isRole = (v) => ROLE_VALUES.includes(v);
export const isAccountStatus = (v) => ACCOUNT_STATUS_VALUES.includes(v);
export const isProductType = (v) => PRODUCT_TYPE_VALUES.includes(v);
export const isProductStatus = (v) => PRODUCT_STATUS_VALUES.includes(v);
export const isOrderType = (v) => ORDER_TYPE_VALUES.includes(v);
export const isOrderStatus = (v) => ORDER_STATUS_VALUES.includes(v);
