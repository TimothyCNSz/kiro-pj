// Backend route registration.
//
// Feature routers (auth / products / cart / redemptions / admin ...) are added
// in later tasks and mounted onto this router. For the skeleton we expose a
// single health check so the adapter + global prefix + response envelope are
// verifiable end-to-end.
//
// Requirements: 19.3 (backend framework skeleton).
import { success } from '../lib/api';
import { buildDefaultAuthRouter } from './auth';
import { buildDefaultProductsRouter } from './products';
import { buildDefaultAdminProductsRouter } from './admin-products';
import { buildDefaultAdminCdksRouter } from './admin-cdks';
import { buildDefaultAdminProductImagesRouter } from './admin-product-images';
import { buildDefaultCartRouter } from './cart';
import { buildDefaultRedemptionsRouter } from './redemptions';
import { buildDefaultUploadsRouter } from './uploads';
import { buildDefaultMeAvatarRouter } from './me-avatar';
import { buildDefaultAdminAlertsRouter } from './admin-alerts';
import { buildDefaultAdminLogsRouter } from './admin-logs';
import { buildDefaultOrdersRouter, buildDefaultPointsRouter } from './orders';
import { buildDefaultAdminUsersRouter } from './admin-users';
import { buildDefaultAdminPointsRouter } from './admin-points';
import { buildDefaultAdminFulfillmentRouter } from './admin-fulfillment';
/** 挂载所有后端路由到给定 Router（已带全局前缀）。 */
export function registerRoutes(router) {
    // 健康检查：确认适配器、全局前缀与统一响应信封贯通。
    router.get('/health', (_req, res) => {
        res.json(success({ service: 'awsome-shop', status: 'ok' }));
    });
    // 认证与会话路由（需求 1、2、20）。
    router.use('/auth', buildDefaultAuthRouter());
    // 商品浏览/搜索/详情路由（需求 4；需登录，需求 1.15）。
    router.use('/products', buildDefaultProductsRouter());
    // 管理端商品路由（需求 12：创建/编辑/上下架），经认证 + 管理员 Guard。
    router.use('/admin/products', buildDefaultAdminProductsRouter());
    // 管理端虚拟商品 CDK 维护（需求 12.2、5.1）：POST /admin/products/:id/cdks。
    router.use('/admin/products', buildDefaultAdminCdksRouter());
    // 管理端商品图集与主图（需求 12.7–12.9、22.9、22.11、22.12）：/admin/products/:id/images*。
    router.use('/admin/products', buildDefaultAdminProductImagesRouter());
    // 服务端购物车路由（需求 6；需登录，需求 1.15、6.6）。
    router.use('/cart', buildDefaultCartRouter());
    // 兑换（结算/立即兑换）路由（需求 7、9.2、5.3；需登录，需求 1.15）。
    router.use('/redemptions', buildDefaultRedemptionsRouter());
    // 兑换历史与订单详情路由（需求 8.3、9.3、9.4、11.1–11.4；需登录，限本人）。
    router.use('/orders', buildDefaultOrdersRouter());
    // 积分余额路由（需求 10.1–10.3；需登录，限本人）。
    router.use('/points', buildDefaultPointsRouter());
    // 当前员工个人资料头像关联（需求 22.9、23.1、23.3、23.4；需登录且限本人）。
    router.use('/me', buildDefaultMeAvatarRouter());
    // 图片上传预签名路由（需求 22；需登录，商品图需管理员、头像限本人）。
    router.use('/uploads', buildDefaultUploadsRouter());
    // 管理端低库存提醒（需求 15.1、15.2）：GET /admin/alerts/low-stock，经认证 + 管理员 Guard。
    router.use('/admin/alerts', buildDefaultAdminAlertsRouter());
    // 管理端员工列表（需求 24）：GET /admin/users?q=&page=，经认证 + 管理员 Guard。
    router.use('/admin/users', buildDefaultAdminUsersRouter());
    // 管理端积分发放/扣除（需求 13）：POST /admin/points/adjust、/batch-adjust，经认证 + 管理员 Guard。
    router.use('/admin/points', buildDefaultAdminPointsRouter());
    // 管理端发货（需求 8、9.3、9.4、14）：POST /admin/orders/:id/ship-physical、ship-virtual，经认证 + 管理员 Guard。
    router.use('/admin/orders', buildDefaultAdminFulfillmentRouter());
    // 管理端操作日志（需求 16.1、16.2、14.4）：GET /admin/logs?page=，经认证 + 管理员 Guard。
    router.use('/admin/logs', buildDefaultAdminLogsRouter());
}
