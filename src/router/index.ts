import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const routes: RouteRecordRaw[] = [
  {
    // 落地页：重定向到商品浏览页（登录后进入商城，而非项目模板首页）。
    path: '/',
    redirect: { name: 'Catalog' },
  },
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/auth/LoginView.vue'),
    meta: { public: true },
  },
  {
    path: '/register',
    name: 'Register',
    component: () => import('@/views/auth/RegisterView.vue'),
    meta: { public: true },
  },
  {
    path: '/verify-email',
    name: 'VerifyEmail',
    component: () => import('@/views/auth/VerifyEmailView.vue'),
    meta: { public: true },
  },
  {
    path: '/cart',
    name: 'Cart',
    component: () => import('@/views/shop/CartView.vue'),
    // 购物车：需登录且仅员工（需求 1.15、6.6、3.1）
    meta: { requiresAuth: true, requiresEmployee: true },
  },
  {
    path: '/profile',
    name: 'Profile',
    component: () => import('@/views/account/ProfileView.vue'),
    // 个人资料页：需登录且仅员工（需求 23、1.15、3.1）
    meta: { requiresAuth: true, requiresEmployee: true },
  },
  {
    // 商品浏览页：需登录（需求 4.1、1.15）
    path: '/catalog',
    name: 'Catalog',
    component: () => import('@/views/shop/CatalogView.vue'),
    meta: { requiresAuth: true, requiresEmployee: true },
  },
  {
    // 商品详情页：需登录（需求 4.5）
    path: '/products/:id',
    name: 'ProductDetail',
    component: () => import('@/views/shop/ProductDetailView.vue'),
    meta: { requiresAuth: true, requiresEmployee: true },
  },
  {
    // 兑换（结算）页：需登录（需求 7.1、7.2、1.15）。
    // 支持购物车结算与 ?productId=&quantity= 立即兑换两种入口。
    path: '/checkout',
    name: 'Checkout',
    component: () => import('@/views/shop/CheckoutView.vue'),
    meta: { requiresAuth: true, requiresEmployee: true },
  },
  {
    // 积分余额页：需登录（需求 10.1、1.15）
    path: '/account/points',
    name: 'Points',
    component: () => import('@/views/account/PointsView.vue'),
    meta: { requiresAuth: true, requiresEmployee: true },
  },
  {
    // 兑换历史页：需登录（需求 11.1–11.4、1.15）
    path: '/account/history',
    name: 'History',
    component: () => import('@/views/account/HistoryView.vue'),
    meta: { requiresAuth: true, requiresEmployee: true },
  },
  {
    // 订单详情页：需登录（需求 8.3、9.3、9.4、1.15）
    path: '/account/orders/:id',
    name: 'OrderDetail',
    component: () => import('@/views/account/OrderDetailView.vue'),
    meta: { requiresAuth: true, requiresEmployee: true },
  },
  {
    // 管理端·商品管理页：需登录且需管理员（需求 3.1–3.3、12.1–12.8）
    path: '/admin/products',
    name: 'AdminProducts',
    component: () => import('@/views/admin/AdminProductsView.vue'),
    meta: { requiresAuth: true, requiresAdmin: true },
  },
  {
    // 管理端发货管理页：需登录 + 管理员（需求 8.2、9.4、14.1、14.2、14.3、3.2）
    path: '/admin/fulfillment',
    name: 'AdminFulfillment',
    component: () => import('@/views/admin/AdminFulfillmentView.vue'),
    meta: { requiresAuth: true, requiresAdmin: true },
  },
  {
    // 管理端概览（低库存提醒）：需登录且需管理员（需求 3.2、15.2）
    path: '/admin/dashboard',
    name: 'AdminDashboard',
    component: () => import('@/views/admin/AdminDashboardView.vue'),
    meta: { requiresAuth: true, requiresAdmin: true },
  },
  {
    // 管理端操作日志（时间倒序）：需登录且需管理员（需求 3.2、16.2）
    path: '/admin/logs',
    name: 'AdminLogs',
    component: () => import('@/views/admin/AdminLogsView.vue'),
    meta: { requiresAuth: true, requiresAdmin: true },
  },
  {
    // 员工列表（管理员）：搜索/分页/选择，转入积分调整流程（需求 24.1–24.5、3.2）
    path: '/admin/users',
    name: 'AdminUsers',
    component: () => import('@/views/admin/AdminUsersView.vue'),
    meta: { requiresAuth: true, requiresAdmin: true },
  },
  {
    // 积分管理（管理员）：单个/批量发放或扣除（需求 13.1–13.6、3.2）
    path: '/admin/points',
    name: 'AdminPoints',
    component: () => import('@/views/admin/AdminPointsView.vue'),
    meta: { requiresAuth: true, requiresAdmin: true },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'NotFound',
    component: () => import('@/views/NotFoundView.vue'),
    meta: { public: true },
  },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
})

/**
 * 路由守卫（客户端第一道防线，权威校验以服务端为准）：
 * - 未登录访问受保护页面 → 重定向登录页（需求 1.15、2.4）。
 * - 非管理员访问管理页面 → 重定向到首页/商品浏览页（需求 3.1、3.2、3.3）。
 */
router.beforeEach(async (to) => {
  const auth = useAuthStore()

  const requiresAuth = to.matched.some((r) => r.meta.requiresAuth)
  const requiresAdmin = to.matched.some((r) => r.meta.requiresAdmin)
  const requiresEmployee = to.matched.some((r) => r.meta.requiresEmployee)

  // 已登录用户访问登录/注册页 → 按角色回各自主页
  if (auth.isAuthenticated && (to.name === 'Login' || to.name === 'Register')) {
    return { name: auth.isAdmin ? 'AdminProducts' : 'Catalog' }
  }

  if (!requiresAuth && !requiresAdmin && !requiresEmployee) {
    return true
  }

  // 未登录 → 登录页（携带来源以便登录后跳回）
  if (!auth.isAuthenticated) {
    return { name: 'Login', query: { redirect: to.fullPath } }
  }

  // 受角色约束的路由需要 role 信息；刷新后 role 可能为空，尝试水合
  if ((requiresAdmin || requiresEmployee) && auth.role === null) {
    try {
      await auth.fetchMe()
    } catch {
      // 会话失效：fetchMe 内部已清理，转登录页
      return { name: 'Login', query: { redirect: to.fullPath } }
    }
    if (!auth.isAuthenticated) {
      return { name: 'Login', query: { redirect: to.fullPath } }
    }
  }

  // 非管理员访问管理页面 → 回商品浏览页（需求 3.1、3.3）
  if (requiresAdmin && !auth.isAdmin) {
    return { name: 'Catalog' }
  }

  // 管理员访问员工专属页面（浏览/购物车/兑换/账户）→ 回管理端（需求 3.2）。
  // 管理员只做管理，不参与兑换，也没有购物车/账户内容。
  if (requiresEmployee && auth.isAdmin) {
    return { name: 'AdminProducts' }
  }

  return true
})

export default router
