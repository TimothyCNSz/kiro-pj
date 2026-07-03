<template>
  <div id="app">
    <!-- 全局导航：登录后、且非公开（登录/注册/验证）页面时显示 -->
    <header v-if="showNav" class="app-nav">
      <RouterLink class="brand" :to="{ name: auth.isAdmin ? 'AdminProducts' : 'Catalog' }">
        {{ t('common.appName') }}
      </RouterLink>

      <!-- 员工购物 / 账户导航（管理员不显示：管理员只做管理，不参与兑换） -->
      <nav v-if="!auth.isAdmin" class="nav-links">
        <RouterLink :to="{ name: 'Catalog' }">{{ t('nav.catalog') }}</RouterLink>
        <RouterLink :to="{ name: 'Cart' }">{{ t('nav.cart') }}</RouterLink>
        <RouterLink :to="{ name: 'History' }">{{ t('nav.orders') }}</RouterLink>
        <RouterLink :to="{ name: 'Points' }">{{ t('nav.pointsHistory') }}</RouterLink>
        <RouterLink :to="{ name: 'Profile' }">{{ t('nav.account') }}</RouterLink>
      </nav>

      <!-- 管理端入口（仅管理员可见） -->
      <nav v-if="auth.isAdmin" class="nav-links nav-admin">
        <RouterLink :to="{ name: 'AdminProducts' }">{{ t('admin.products') }}</RouterLink>
        <RouterLink :to="{ name: 'AdminUsers' }">{{ t('admin.employees') }}</RouterLink>
        <RouterLink :to="{ name: 'AdminFulfillment' }">{{ t('admin.orders') }}</RouterLink>
        <RouterLink :to="{ name: 'AdminLogs' }">{{ t('admin.auditLog') }}</RouterLink>
        <RouterLink :to="{ name: 'AdminDashboard' }">{{ t('admin.lowStockAlert') }}</RouterLink>
      </nav>

      <div class="nav-right">
        <LanguageSwitcher />
        <button class="logout-btn" type="button" @click="onLogout">{{ t('nav.logout') }}</button>
      </div>
    </header>

    <main :class="{ 'app-main': showNav }">
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import LanguageSwitcher from '@/components/LanguageSwitcher.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

// 仅在已登录且当前不是公开页面（登录/注册/验证/404）时展示导航。
const showNav = computed(() => auth.isAuthenticated && !route.meta.public)

async function onLogout(): Promise<void> {
  await auth.logout()
  router.push({ name: 'Login' })
}
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

#app {
  min-height: 100vh;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen,
    Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
  color: #2c3e50;
}

.app-nav {
  display: flex;
  align-items: center;
  gap: 1.25rem;
  padding: 0.75rem 1.5rem;
  background: #fff;
  border-bottom: 1px solid #e0e0e0;
  flex-wrap: wrap;
}

.brand {
  font-size: 1.15rem;
  font-weight: 700;
  color: #42b983;
  text-decoration: none;
}

.nav-links {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.nav-links a {
  color: #55606a;
  text-decoration: none;
  font-size: 0.95rem;
  padding: 0.25rem 0;
  border-bottom: 2px solid transparent;
}

.nav-links a:hover {
  color: #2c3e50;
}

.nav-links a.router-link-active {
  color: #42b983;
  border-bottom-color: #42b983;
}

.nav-admin {
  padding-left: 1rem;
  margin-left: 0.25rem;
  border-left: 1px solid #eee;
}

.nav-admin a {
  color: #8a5a00;
}

.nav-admin a.router-link-active {
  color: #b26a00;
  border-bottom-color: #b26a00;
}

.nav-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 1rem;
}

.logout-btn {
  padding: 0.4rem 0.9rem;
  font-size: 0.9rem;
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  background: #f7f9fa;
  color: #55606a;
  cursor: pointer;
}

.logout-btn:hover {
  background: #eef1f3;
}

.app-main {
  padding: 0;
}
</style>
