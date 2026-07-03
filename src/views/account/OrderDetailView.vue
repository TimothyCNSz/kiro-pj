<template>
  <div class="detail-page">
    <button class="btn-link" type="button" @click="goBack">← {{ t('common.back') }}</button>

    <!-- 加载中 -->
    <p v-if="loading" class="state-hint">{{ t('common.loading') }}</p>

    <!-- 加载失败 -->
    <div v-else-if="errorMessage" class="state-hint state-error">
      <span>{{ errorMessage }}</span>
      <button class="btn-secondary" type="button" @click="load">{{ t('common.retry') }}</button>
    </div>

    <section v-else-if="order" class="detail-card">
      <header class="detail-header">
        <h1 class="detail-title">{{ t('account.orderNo') }}：{{ order.id }}</h1>
        <span class="order-status" :class="statusClass">{{ statusLabel }}</span>
      </header>

      <dl class="meta">
        <div class="meta-row">
          <dt>{{ t('account.orderDate') }}</dt>
          <dd>{{ formatDate(order.createdAt) }}</dd>
        </div>
        <div class="meta-row">
          <dt>{{ t('admin.productType') }}</dt>
          <dd>{{ isPhysical ? t('catalog.typePhysical') : t('catalog.typeVirtual') }}</dd>
        </div>
        <div class="meta-row">
          <dt>{{ t('account.orderTotal') }}</dt>
          <dd class="points">-{{ order.pointsSpent }}</dd>
        </div>
      </dl>

      <!-- 兑换商品 -->
      <h2 class="section-title">{{ t('account.orderItems') }}</h2>
      <ul class="item-list">
        <li v-for="(item, idx) in order.items" :key="idx" class="item-row">
          <span class="item-name">{{ item.productName }}</span>
          <span class="item-qty">×{{ item.quantity }}</span>
          <span class="item-points">{{ item.unitPoints * item.quantity }}</span>
        </li>
      </ul>

      <!-- 实物：物流展示（需求 8.3、8.4） -->
      <template v-if="isPhysical">
        <h2 class="section-title">{{ t('account.trackingHint') }}</h2>
        <div v-if="order.shippingAddress" class="address">
          <p class="address-line">
            <span class="address-label">{{ t('checkout.recipient') }}：</span>{{ order.shippingAddress.recipient }}
          </p>
          <p class="address-line">
            <span class="address-label">{{ t('checkout.phone') }}：</span>{{ order.shippingAddress.phone }}
          </p>
          <p class="address-line">
            <span class="address-label">{{ t('checkout.addressDetail') }}：</span>{{ order.shippingAddress.detail }}
          </p>
        </div>

        <!-- 已发货：展示物流编号 + 物流跟踪明细（本阶段为演示数据，需求 8.3） -->
        <template v-if="isShipped">
          <p class="tracking-no">
            {{ t('account.trackingNo') }}：<strong>{{ order.trackingNo }}</strong>
          </p>
          <ol class="timeline">
            <li v-for="(node, idx) in trackingTimeline" :key="idx" class="timeline-node">
              <span class="timeline-dot" :class="{ 'is-latest': idx === 0 }"></span>
              <div class="timeline-body">
                <p class="timeline-desc">{{ node.description }}</p>
                <p class="timeline-time">{{ node.time }}</p>
              </div>
            </li>
          </ol>
        </template>

        <!-- 未发货（需求 8.4） -->
        <p v-else class="pending-hint">{{ t('account.pendingShipment') }}</p>
      </template>

      <!-- 虚拟：CDK 展示（需求 9.3、9.4） -->
      <template v-else>
        <h2 class="section-title">{{ t('account.cdkTitle') }}</h2>
        <!-- 已发货：展示 CDK（需求 9.4） -->
        <ul v-if="isShipped && cdks.length > 0" class="cdk-list">
          <li v-for="(code, idx) in cdks" :key="idx" class="cdk-item">
            <code>{{ code }}</code>
          </li>
        </ul>
        <!-- 未发货：不展示 CDK 且提示待发货（需求 9.3） -->
        <p v-else class="pending-hint">{{ t('account.pendingShipment') }}</p>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { getOrder, type OrderDetail } from '@/api/orders'
import { toApiError } from '@/api/cart'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const order = ref<OrderDetail | null>(null)
const loading = ref(false)
const errorMessage = ref('')

const orderId = computed(() => String(route.params.id ?? ''))
const isPhysical = computed(() => order.value?.type === 'physical')
const isShipped = computed(() => order.value?.status === 'shipped')

const statusLabel = computed(() => (isShipped.value ? t('account.shipped') : t('account.pendingShipment')))
const statusClass = computed(() => (isShipped.value ? 'is-shipped' : 'is-pending'))

// 仅在已发货时才可能持有 CDK；未发货时后端不返回（需求 9.3、9.4）
const cdks = computed<string[]>(() => (isShipped.value ? order.value?.cdks ?? [] : []))

/**
 * 物流跟踪明细（演示数据）：仅在实物订单已发货时基于物流编号与兑换时间生成，
 * 用于呈现物流状态信息（需求 8.3，明细允许使用假数据）。倒序展示，最新在前。
 */
const trackingTimeline = computed<{ time: string; description: string }[]>(() => {
  if (!order.value || !isPhysical.value || !isShipped.value) return []
  const base = new Date(order.value.createdAt)
  const baseTime = Number.isNaN(base.getTime()) ? Date.now() : base.getTime()
  const day = 24 * 60 * 60 * 1000
  const nodes = [
    { offset: 0, description: t('account.trackingOutbound') },
    { offset: 1, description: t('account.trackingInTransit') },
    { offset: 2, description: t('account.trackingArrived') },
    { offset: 3, description: t('account.trackingDelivering') },
  ]
  return nodes
    .map((n) => ({
      time: new Date(baseTime + n.offset * day).toLocaleString(),
      description: n.description,
    }))
    .reverse()
})

async function load(): Promise<void> {
  if (!orderId.value) {
    errorMessage.value = t('errors.UNKNOWN')
    return
  }
  loading.value = true
  errorMessage.value = ''
  try {
    order.value = await getOrder(orderId.value)
  } catch (err) {
    const apiErr = toApiError(err)
    errorMessage.value = apiErr.message || t('errors.UNKNOWN')
  } finally {
    loading.value = false
  }
}

function goBack(): void {
  router.push({ name: 'History' })
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

onMounted(load)
</script>

<style scoped>
.detail-page {
  max-width: 720px;
  margin: 0 auto;
  padding: 1.5rem;
}

.btn-link {
  background: none;
  border: none;
  color: #42b983;
  cursor: pointer;
  font-size: 0.9rem;
  padding: 0;
  margin-bottom: 1rem;
}

.detail-card {
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  background: #fff;
  padding: 1.5rem;
}

.detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}

.detail-title {
  margin: 0;
  font-size: 1.1rem;
  color: #2c3e50;
  word-break: break-all;
}

.order-status {
  font-size: 0.78rem;
  padding: 0.2rem 0.6rem;
  border-radius: 999px;
  flex-shrink: 0;
}

.order-status.is-shipped {
  background: #e8f5e9;
  color: #1b5e20;
}

.order-status.is-pending {
  background: #fff3e0;
  color: #e65100;
}

.meta {
  margin: 0 0 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.meta-row {
  display: flex;
  justify-content: space-between;
  font-size: 0.9rem;
}

.meta-row dt {
  color: #888;
}

.meta-row dd {
  margin: 0;
  color: #2c3e50;
}

.meta-row .points {
  color: #e67e22;
  font-weight: 600;
}

.section-title {
  margin: 1.25rem 0 0.6rem;
  font-size: 1rem;
  color: #2c3e50;
  border-bottom: 1px solid #eee;
  padding-bottom: 0.4rem;
}

.item-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.item-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0;
  border-bottom: 1px dashed #f0f0f0;
  font-size: 0.9rem;
}

.item-name {
  flex: 1;
  color: #2c3e50;
}

.item-qty {
  color: #888;
}

.item-points {
  color: #42b983;
  font-weight: 600;
  min-width: 48px;
  text-align: right;
}

.address {
  font-size: 0.9rem;
  color: #444;
  margin-bottom: 0.75rem;
}

.address-line {
  margin: 0 0 0.25rem;
}

.address-label {
  color: #888;
}

.tracking-no {
  font-size: 0.9rem;
  color: #2c3e50;
  margin: 0 0 1rem;
}

.timeline {
  list-style: none;
  margin: 0;
  padding: 0;
}

.timeline-node {
  position: relative;
  display: flex;
  gap: 0.75rem;
  padding: 0 0 1rem 0.5rem;
  border-left: 2px solid #e0e0e0;
  margin-left: 0.35rem;
}

.timeline-node:last-child {
  border-left-color: transparent;
}

.timeline-dot {
  position: absolute;
  left: -0.45rem;
  top: 0.2rem;
  width: 0.7rem;
  height: 0.7rem;
  border-radius: 50%;
  background: #c0c0c0;
}

.timeline-dot.is-latest {
  background: #42b983;
}

.timeline-body {
  padding-left: 0.5rem;
}

.timeline-desc {
  margin: 0;
  font-size: 0.9rem;
  color: #2c3e50;
}

.timeline-time {
  margin: 0.15rem 0 0;
  font-size: 0.78rem;
  color: #999;
}

.cdk-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.cdk-item {
  background: #f5f7fa;
  border: 1px dashed #cbd5e0;
  border-radius: 6px;
  padding: 0.6rem 0.8rem;
}

.cdk-item code {
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 0.95rem;
  color: #2c3e50;
  word-break: break-all;
}

.pending-hint {
  color: #e65100;
  font-size: 0.95rem;
  margin: 0.5rem 0;
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
