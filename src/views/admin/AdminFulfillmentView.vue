<template>
  <div class="fulfillment-page">
    <header class="page-header">
      <div>
        <h1 class="page-title">{{ t('admin.fulfillment.title') }}</h1>
        <p class="page-subtitle">{{ t('admin.fulfillment.subtitle') }}</p>
      </div>
      <button class="btn-secondary" type="button" :disabled="loading" @click="() => load(page)">
        {{ t('admin.fulfillment.refresh') }}
      </button>
    </header>

    <!-- 筛选：状态 / 类型 -->
    <div class="filters">
      <label class="filter">
        <span class="filter-label">{{ t('admin.fulfillment.filterStatus') }}</span>
        <select v-model="statusFilter" class="filter-select" @change="() => load(1)">
          <option value="">{{ t('admin.fulfillment.all') }}</option>
          <option value="pending_shipment">{{ t('admin.fulfillment.statusPending') }}</option>
          <option value="shipped">{{ t('admin.fulfillment.statusShipped') }}</option>
        </select>
      </label>
      <label class="filter">
        <span class="filter-label">{{ t('admin.fulfillment.filterType') }}</span>
        <select v-model="typeFilter" class="filter-select" @change="() => load(1)">
          <option value="">{{ t('admin.fulfillment.all') }}</option>
          <option value="physical">{{ t('admin.fulfillment.typePhysical') }}</option>
          <option value="virtual">{{ t('admin.fulfillment.typeVirtual') }}</option>
        </select>
      </label>
    </div>

    <p v-if="loading" class="state-hint">{{ t('common.loading') }}</p>
    <div v-else-if="errorMessage" class="state-hint state-error">
      <span>{{ errorMessage }}</span>
      <button class="btn-secondary" type="button" @click="() => load(page)">
        {{ t('common.retry') }}
      </button>
    </div>
    <p v-else-if="rows.length === 0" class="state-hint">{{ t('admin.fulfillment.empty') }}</p>

    <ul v-else class="order-list">
      <li v-for="row in rows" :key="row.id" class="order-row">
        <div class="order-head">
          <div class="order-ident">
            <span class="order-id" :title="row.id">#{{ shortId(row.id) }}</span>
            <span class="order-type-tag" :class="row.type">
              {{ row.type === 'physical' ? t('admin.fulfillment.typePhysical') : t('admin.fulfillment.typeVirtual') }}
            </span>
            <span class="order-user">{{ row.userEmail }}</span>
          </div>
          <span class="order-status" :class="row.status === 'shipped' ? 'is-shipped' : 'is-pending'">
            {{ row.status === 'shipped' ? t('admin.fulfillment.statusShipped') : t('admin.fulfillment.statusPending') }}
          </span>
        </div>

        <!-- 商品摘要 -->
        <p class="order-items">
          <span v-for="(it, idx) in row.items" :key="idx" class="order-item">
            {{ it.productName }} ×{{ it.quantity }}<span v-if="idx < row.items.length - 1">，</span>
          </span>
          <span class="order-points">-{{ row.pointsSpent }}</span>
        </p>

        <!-- 实物收货地址 -->
        <p v-if="row.type === 'physical' && row.shippingAddress" class="order-address">
          {{ row.shippingAddress.recipient }} · {{ row.shippingAddress.phone }} · {{ row.shippingAddress.detail }}
        </p>

        <!-- 待发货：实物填物流编号，虚拟一键发货 -->
        <div v-if="row.status === 'pending_shipment'" class="ship-form">
          <template v-if="row.type === 'physical'">
            <input
              v-model.trim="trackingInputs[row.id]"
              class="text-input"
              type="text"
              :placeholder="t('admin.fulfillment.trackingPlaceholder')"
              :disabled="busyId === row.id"
              @input="rowErrors[row.id] = ''"
            />
            <button class="btn-primary" type="button" :disabled="busyId === row.id" @click="shipPhysical(row)">
              {{ busyId === row.id ? t('common.submitting') : t('admin.fulfillment.shipPhysical') }}
            </button>
          </template>
          <button
            v-else
            class="btn-primary"
            type="button"
            :disabled="busyId === row.id"
            @click="shipVirtual(row)"
          >
            {{ busyId === row.id ? t('common.submitting') : t('admin.fulfillment.shipVirtual') }}
          </button>
        </div>

        <!-- 已发货结果 -->
        <div v-else class="ship-result">
          <p v-if="row.type === 'physical'" class="result-line">
            {{ t('admin.trackingNo') }}：<strong>{{ row.trackingNo }}</strong>
          </p>
          <template v-else>
            <p class="result-line">{{ t('admin.fulfillment.deliveredCdks') }}</p>
            <ul class="cdk-list">
              <li v-for="(code, idx) in row.cdks" :key="idx" class="cdk-item"><code>{{ code }}</code></li>
            </ul>
          </template>
        </div>

        <p v-if="rowErrors[row.id]" class="field-error">{{ rowErrors[row.id] }}</p>
      </li>
    </ul>

    <!-- 分页 -->
    <nav v-if="!loading && !errorMessage && totalPages > 1" class="pagination">
      <button class="btn-secondary" type="button" :disabled="page <= 1" @click="() => load(page - 1)">
        {{ t('common.previous') }}
      </button>
      <span class="page-indicator">{{ page }} / {{ totalPages }}</span>
      <button class="btn-secondary" type="button" :disabled="page >= totalPages" @click="() => load(page + 1)">
        {{ t('common.next') }}
      </button>
    </nav>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { fulfillment, type AdminOrderRow, type OrderStatus } from '@/api/admin'
import type { ProductType } from '@/api/admin'
import { toApiError } from '@/api/cart'

const { t } = useI18n()

const PAGE_SIZE = 10

const rows = ref<AdminOrderRow[]>([])
const page = ref(1)
const total = ref(0)
const loading = ref(false)
const errorMessage = ref('')

const statusFilter = ref<'' | OrderStatus>('')
const typeFilter = ref<'' | ProductType>('')

// 行级状态
const busyId = ref<string | null>(null)
const trackingInputs = ref<Record<string, string>>({})
const rowErrors = ref<Record<string, string>>({})

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))

function shortId(id: string): string {
  return id.slice(0, 8)
}

async function load(target = 1): Promise<void> {
  const next = Math.max(1, target)
  loading.value = true
  errorMessage.value = ''
  try {
    const data = await fulfillment.list({
      status: statusFilter.value || undefined,
      type: typeFilter.value || undefined,
      page: next,
      pageSize: PAGE_SIZE,
    })
    rows.value = data.list
    total.value = data.total
    page.value = data.page || next
  } catch (err) {
    errorMessage.value = toApiError(err).message || t('errors.UNKNOWN')
  } finally {
    loading.value = false
  }
}

/** 实物发货：物流编号非空校验（需求 14.3），成功后刷新当前页 */
async function shipPhysical(row: AdminOrderRow): Promise<void> {
  const trackingNo = (trackingInputs.value[row.id] ?? '').trim()
  if (!trackingNo) {
    rowErrors.value = { ...rowErrors.value, [row.id]: t('admin.fulfillment.trackingRequired') }
    return
  }
  rowErrors.value = { ...rowErrors.value, [row.id]: '' }
  busyId.value = row.id
  try {
    await fulfillment.shipPhysical(row.id, { trackingNo })
    await load(page.value)
  } catch (err) {
    rowErrors.value = { ...rowErrors.value, [row.id]: toApiError(err).message || t('errors.UNKNOWN') }
  } finally {
    busyId.value = null
  }
}

/** 虚拟发货：关联并交付 CDK，成功后刷新当前页 */
async function shipVirtual(row: AdminOrderRow): Promise<void> {
  rowErrors.value = { ...rowErrors.value, [row.id]: '' }
  busyId.value = row.id
  try {
    await fulfillment.shipVirtual(row.id)
    await load(page.value)
  } catch (err) {
    rowErrors.value = { ...rowErrors.value, [row.id]: toApiError(err).message || t('errors.UNKNOWN') }
  } finally {
    busyId.value = null
  }
}

onMounted(() => load(1))
</script>

<style scoped>
.fulfillment-page {
  max-width: 900px;
  margin: 0 auto;
  padding: 1.5rem;
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
}

.page-title {
  margin: 0 0 0.3rem;
  font-size: 1.4rem;
  color: #2c3e50;
}

.page-subtitle {
  margin: 0;
  color: #888;
  font-size: 0.9rem;
}

.filters {
  display: flex;
  gap: 1.25rem;
  margin-bottom: 1.25rem;
}

.filter {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.filter-label {
  font-size: 0.85rem;
  color: #666;
}

.filter-select,
.text-input {
  padding: 0.45rem 0.6rem;
  border: 1px solid #ccc;
  border-radius: 6px;
  font-size: 0.9rem;
}

.text-input {
  min-width: 220px;
}

.text-input:disabled {
  background: #f5f5f5;
}

.order-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.order-row {
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  padding: 1rem;
  background: #fff;
}

.order-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.order-ident {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.order-id {
  font-family: Consolas, monospace;
  color: #2c3e50;
}

.order-type-tag {
  font-size: 0.72rem;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
}

.order-type-tag.physical {
  background: #e3f2fd;
  color: #1565c0;
}

.order-type-tag.virtual {
  background: #f3e5f5;
  color: #7b1fa2;
}

.order-user {
  font-size: 0.85rem;
  color: #888;
}

.order-status {
  font-size: 0.75rem;
  padding: 0.2rem 0.6rem;
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

.order-items {
  margin: 0.7rem 0 0.3rem;
  font-size: 0.92rem;
  color: #2c3e50;
}

.order-points {
  margin-left: 0.5rem;
  color: #e67e22;
  font-weight: 600;
}

.order-address {
  margin: 0 0 0.3rem;
  font-size: 0.85rem;
  color: #666;
}

.ship-form {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  margin-top: 0.6rem;
  flex-wrap: wrap;
}

.ship-result {
  margin-top: 0.6rem;
  padding-top: 0.6rem;
  border-top: 1px dashed #eee;
}

.result-line {
  margin: 0 0 0.3rem;
  font-size: 0.9rem;
  color: #2c3e50;
}

.cdk-list {
  list-style: none;
  margin: 0.3rem 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.cdk-item {
  background: #f5f7fa;
  border: 1px dashed #cbd5e0;
  border-radius: 6px;
  padding: 0.5rem 0.7rem;
}

.cdk-item code {
  font-family: Consolas, monospace;
  color: #2c3e50;
}

.btn-primary {
  padding: 0.5rem 1.1rem;
  font-size: 0.9rem;
  border: none;
  border-radius: 6px;
  background: #42b983;
  color: #fff;
  cursor: pointer;
}

.btn-primary:disabled {
  background: #a5d6c1;
  cursor: not-allowed;
}

.btn-secondary {
  padding: 0.5rem 1rem;
  font-size: 0.9rem;
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

.field-error {
  margin: 0.5rem 0 0;
  color: #b71c1c;
  font-size: 0.85rem;
}

.state-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding: 2rem 0;
  color: #666;
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
</style>
