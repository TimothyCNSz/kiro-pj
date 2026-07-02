<template>
  <div class="dashboard-page">
    <header class="dashboard-header">
      <h1 class="dashboard-title">{{ t('admin.dashboard') }}</h1>
    </header>

    <section class="alert-card">
      <h2 class="alert-title">{{ t('admin.lowStockAlert') }}</h2>

      <!-- 加载中 -->
      <p v-if="loading" class="state-hint">{{ t('common.loading') }}</p>

      <!-- 加载失败 -->
      <div v-else-if="errorMessage" class="state-hint state-error">
        <span>{{ errorMessage }}</span>
        <button class="btn-secondary" type="button" @click="load">{{ t('common.retry') }}</button>
      </div>

      <!-- 空状态：当前无低库存提醒（需求 15.2） -->
      <p v-else-if="alerts.length === 0" class="state-hint">{{ t('admin.lowStockEmpty') }}</p>

      <!-- 低库存提醒列表（需求 15.2） -->
      <ul v-else class="alert-list">
        <li v-for="alert in alerts" :key="alert.id" class="alert-item">
          <div class="alert-main">
            <span class="alert-label">{{ t('admin.lowStockProduct') }}</span>
            <span class="alert-product" :title="alert.productId">{{ alert.productId }}</span>
          </div>
          <div class="alert-side">
            <span class="alert-label">{{ t('admin.lowStockTriggeredAt') }}</span>
            <span class="alert-time">{{ formatDateTime(alert.triggeredAt) }}</span>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { alerts as alertsApi, type LowStockAlert } from '@/api/admin'
import { toApiError } from '@/api/cart'
import { formatDate } from '@/utils'

const { t } = useI18n()

const alerts = ref<LowStockAlert[]>([])
const loading = ref(false)
const errorMessage = ref('')

async function load(): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  try {
    alerts.value = await alertsApi.lowStock()
  } catch (err) {
    const apiErr = toApiError(err)
    errorMessage.value = apiErr.message || t('errors.UNKNOWN')
  } finally {
    loading.value = false
  }
}

function formatDateTime(iso: string): string {
  return formatDate(iso, 'YYYY-MM-DD HH:mm:ss')
}

onMounted(load)
</script>

<style scoped>
.dashboard-page {
  max-width: 720px;
  margin: 0 auto;
  padding: 1.5rem;
}

.dashboard-header {
  margin-bottom: 1.25rem;
}

.dashboard-title {
  margin: 0;
  font-size: 1.5rem;
  color: #2c3e50;
}

.alert-card {
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  background: #fff;
  padding: 1.25rem 1.5rem;
}

.alert-title {
  margin: 0 0 1rem;
  font-size: 1.1rem;
  color: #e65100;
}

.alert-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.alert-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.75rem 1rem;
  border: 1px solid #ffe0b2;
  border-radius: 6px;
  background: #fff8f0;
}

.alert-main,
.alert-side {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
}

.alert-side {
  align-items: flex-end;
  flex-shrink: 0;
}

.alert-label {
  font-size: 0.75rem;
  color: #999;
}

.alert-product {
  font-size: 0.95rem;
  color: #2c3e50;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.alert-time {
  font-size: 0.9rem;
  color: #e65100;
  white-space: nowrap;
}

.state-hint {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 1.5rem 0;
  color: #666;
  justify-content: center;
}

.state-error {
  color: #b71c1c;
}

.btn-secondary {
  padding: 0.5rem 1rem;
  font-size: 0.95rem;
  border: none;
  border-radius: 6px;
  background: #e0e0e0;
  color: #333;
  cursor: pointer;
}
</style>
