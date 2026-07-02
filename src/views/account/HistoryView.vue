<template>
  <div class="history-page">
    <header class="history-header">
      <h1 class="history-title">{{ t('account.orders') }}</h1>
    </header>

    <!-- 加载中 -->
    <p v-if="loading" class="state-hint">{{ t('common.loading') }}</p>

    <!-- 加载失败 -->
    <div v-else-if="errorMessage" class="state-hint state-error">
      <span>{{ errorMessage }}</span>
      <button class="btn-secondary" type="button" @click="() => load(page)">
        {{ t('common.retry') }}
      </button>
    </div>

    <!-- 空状态：尚无任何兑换记录（需求 11.4） -->
    <p v-else-if="orders.length === 0" class="state-hint">{{ t('account.ordersEmpty') }}</p>

    <!-- 兑换历史列表：服务端已按时间从新到旧排序（需求 11.1、11.2） -->
    <ul v-else class="order-list">
      <li v-for="order in orders" :key="order.id" class="order-item">
        <RouterLink
          class="order-link"
          :to="{ name: 'OrderDetail', params: { id: order.id } }"
        >
          <div class="order-main">
            <p class="order-names" :title="itemsSummary(order)">{{ itemsSummary(order) }}</p>
            <p class="order-date">{{ formatDate(order.createdAt) }}</p>
          </div>
          <div class="order-side">
            <p class="order-points">-{{ order.pointsSpent }}</p>
            <span class="order-status" :class="statusClass(order.status)">
              {{ statusLabel(order.status) }}
            </span>
          </div>
        </RouterLink>
      </li>
    </ul>

    <!-- 分页（需求 11.3） -->
    <nav v-if="!loading && !errorMessage && totalPages > 1" class="pagination">
      <button
        class="btn-secondary"
        type="button"
        :disabled="page <= 1"
        @click="() => load(page - 1)"
      >
        {{ t('common.previous') }}
      </button>
      <span class="page-indicator">{{ page }} / {{ totalPages }}</span>
      <button
        class="btn-secondary"
        type="button"
        :disabled="page >= totalPages"
        @click="() => load(page + 1)"
      >
        {{ t('common.next') }}
      </button>
    </nav>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { listOrders, type OrderRecord, type OrderStatus } from '@/api/orders'
import { toApiError } from '@/api/cart'

const { t } = useI18n()

const PAGE_SIZE = 10

const orders = ref<OrderRecord[]>([])
const page = ref(1)
const total = ref(0)
const loading = ref(false)
const errorMessage = ref('')

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))

async function load(target = 1): Promise<void> {
  const next = Math.max(1, target)
  loading.value = true
  errorMessage.value = ''
  try {
    const data = await listOrders(next, PAGE_SIZE)
    orders.value = data.list
    total.value = data.total
    page.value = data.page || next
  } catch (err) {
    const apiErr = toApiError(err)
    errorMessage.value = apiErr.message || t('errors.UNKNOWN')
  } finally {
    loading.value = false
  }
}

/** 拼接订单内商品名称摘要（含数量），用于列表行展示（需求 11.1） */
function itemsSummary(order: OrderRecord): string {
  if (!order.items || order.items.length === 0) return '—'
  return order.items.map((it) => `${it.productName} ×${it.quantity}`).join('，')
}

/** 状态文案：待发货 / 已发货（需求 8.4、9.3、11.1） */
function statusLabel(status: OrderStatus): string {
  return status === 'shipped' ? t('account.shipped') : t('account.pendingShipment')
}

function statusClass(status: OrderStatus): string {
  return status === 'shipped' ? 'is-shipped' : 'is-pending'
}

/** 本地化展示兑换时间 */
function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

onMounted(() => load(1))
</script>

<style scoped>
.history-page {
  max-width: 720px;
  margin: 0 auto;
  padding: 1.5rem;
}

.history-header {
  margin-bottom: 1.25rem;
}

.history-title {
  margin: 0;
  font-size: 1.5rem;
  color: #2c3e50;
}

.order-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.order-item {
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  background: #fff;
  transition: box-shadow 0.2s;
}

.order-item:hover {
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
}

.order-link {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.9rem 1.1rem;
  color: inherit;
  text-decoration: none;
}

.order-main {
  min-width: 0;
}

.order-names {
  margin: 0 0 0.3rem;
  font-size: 1rem;
  color: #2c3e50;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.order-date {
  margin: 0;
  font-size: 0.82rem;
  color: #888;
}

.order-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.35rem;
  flex-shrink: 0;
}

.order-points {
  margin: 0;
  font-weight: 600;
  color: #e67e22;
}

.order-status {
  font-size: 0.78rem;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
}

.order-status.is-shipped {
  background: #e8f5e9;
  color: #1b5e20;
}

.order-status.is-pending {
  background: #fff3e0;
  color: #e65100;
}

.state-hint {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 2rem 0;
  color: #666;
  justify-content: center;
}

.state-error {
  color: #b71c1c;
}

.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  margin-top: 1.5rem;
}

.page-indicator {
  font-size: 0.9rem;
  color: #555;
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

.btn-secondary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
