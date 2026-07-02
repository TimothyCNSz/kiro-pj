<template>
  <div class="fulfillment-page">
    <header class="page-header">
      <h1 class="page-title">{{ t('admin.fulfillment.title') }}</h1>
      <p class="page-subtitle">{{ t('admin.fulfillment.subtitle') }}</p>
    </header>

    <!-- 添加待发货订单 -->
    <section class="add-panel">
      <h2 class="section-title">{{ t('admin.fulfillment.addOrder') }}</h2>
      <form class="add-form" @submit.prevent="addOrder">
        <div class="field">
          <label class="field-label" for="order-id">{{ t('admin.fulfillment.orderIdLabel') }}</label>
          <input
            id="order-id"
            v-model.trim="newOrderId"
            class="text-input"
            type="text"
            :placeholder="t('admin.fulfillment.orderIdPlaceholder')"
            @input="addError = ''"
          />
        </div>
        <div class="field">
          <label class="field-label" for="order-type">{{ t('admin.fulfillment.orderTypeLabel') }}</label>
          <select id="order-type" v-model="newOrderType" class="text-input">
            <option value="physical">{{ t('admin.fulfillment.typePhysical') }}</option>
            <option value="virtual">{{ t('admin.fulfillment.typeVirtual') }}</option>
          </select>
        </div>
        <button class="btn-primary" type="submit">{{ t('admin.fulfillment.addButton') }}</button>
      </form>
      <p v-if="addError" class="field-error">{{ addError }}</p>
    </section>

    <!-- 待发货订单列表 -->
    <section class="list-panel">
      <h2 class="section-title">{{ t('admin.fulfillment.pendingListTitle') }}</h2>

      <p v-if="rows.length === 0" class="state-hint">{{ t('admin.fulfillment.listEmpty') }}</p>

      <ul v-else class="order-list">
        <li v-for="row in rows" :key="row.orderId" class="order-row">
          <div class="order-head">
            <div class="order-ident">
              <span class="order-id">{{ row.orderId }}</span>
              <span class="order-type-tag" :class="row.type">
                {{ row.type === 'physical' ? t('admin.fulfillment.typePhysical') : t('admin.fulfillment.typeVirtual') }}
              </span>
            </div>
            <div class="order-head-right">
              <span class="order-status" :class="row.status === 'shipped' ? 'is-shipped' : 'is-pending'">
                {{ row.status === 'shipped' ? t('admin.fulfillment.statusShipped') : t('admin.fulfillment.statusPending') }}
              </span>
              <button
                v-if="row.status === 'pending'"
                class="btn-link-danger"
                type="button"
                @click="removeOrder(row.orderId)"
              >
                {{ t('admin.fulfillment.remove') }}
              </button>
            </div>
          </div>

          <!-- 实物：物流编号上传（需求 8.2、14.1、14.3） -->
          <div v-if="row.type === 'physical' && row.status === 'pending'" class="ship-form">
            <div class="field field-inline">
              <label class="field-label" :for="`tracking-${row.orderId}`">
                {{ t('admin.trackingNo') }}
              </label>
              <input
                :id="`tracking-${row.orderId}`"
                v-model.trim="row.trackingInput"
                class="text-input"
                type="text"
                :placeholder="t('admin.trackingPlaceholder')"
                :disabled="row.submitting"
                @input="row.error = ''"
              />
            </div>
            <button
              class="btn-primary"
              type="button"
              :disabled="row.submitting"
              @click="shipPhysical(row)"
            >
              {{ row.submitting ? t('common.submitting') : t('admin.fulfillment.shipPhysical') }}
            </button>
          </div>

          <!-- 虚拟：关联 CDK 完成虚拟发货（需求 9.4、14.2） -->
          <div v-else-if="row.type === 'virtual' && row.status === 'pending'" class="ship-form">
            <button
              class="btn-primary"
              type="button"
              :disabled="row.submitting"
              @click="shipVirtual(row)"
            >
              {{ row.submitting ? t('common.submitting') : t('admin.fulfillment.shipVirtual') }}
            </button>
          </div>

          <!-- 已发货结果展示 -->
          <div v-if="row.status === 'shipped'" class="ship-result">
            <template v-if="row.type === 'physical'">
              <p class="result-line">
                {{ t('admin.trackingNo') }}：<strong>{{ row.trackingNo }}</strong>
              </p>
              <p v-if="row.carrier" class="result-line result-muted">
                {{ t('admin.fulfillment.carrier') }}：{{ row.carrier }}
              </p>
              <ol v-if="row.tracking.length > 0" class="timeline">
                <li v-for="(node, idx) in row.tracking" :key="idx" class="timeline-node">
                  <span class="timeline-dot" :class="{ 'is-latest': idx === 0 }"></span>
                  <div class="timeline-body">
                    <p class="timeline-status">{{ node.status }}</p>
                    <p class="timeline-desc">{{ node.description }}</p>
                  </div>
                </li>
              </ol>
            </template>

            <template v-else>
              <p class="result-line">{{ t('admin.fulfillment.deliveredCdks') }}</p>
              <ul class="cdk-list">
                <li v-for="(code, idx) in row.cdks" :key="idx" class="cdk-item">
                  <code>{{ code }}</code>
                </li>
              </ul>
            </template>
          </div>

          <!-- 行级错误提示 -->
          <p v-if="row.error" class="field-error">{{ row.error }}</p>
        </li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { fulfillment, type ProductType } from '@/api/admin'
import { toApiError } from '@/api/cart'

const { t } = useI18n()

/** 一行待发货订单的本地工作台状态。 */
interface FulfillmentRow {
  orderId: string
  type: ProductType
  status: 'pending' | 'shipped'
  /** 实物物流编号输入。 */
  trackingInput: string
  /** 提交中标志（防重复提交）。 */
  submitting: boolean
  /** 行级错误提示。 */
  error: string
  /** 已发货后记录的物流编号（实物）。 */
  trackingNo: string
  /** 承运商（实物，演示假数据）。 */
  carrier: string
  /** 物流跟踪节点（实物，演示假数据）。 */
  tracking: { status: string; description: string }[]
  /** 已交付 CDK（虚拟）。 */
  cdks: string[]
}

const rows = ref<FulfillmentRow[]>([])

const newOrderId = ref('')
const newOrderType = ref<ProductType>('physical')
const addError = ref('')

/** 将订单加入本地待发货列表（校验非空且去重）。 */
function addOrder(): void {
  const id = newOrderId.value.trim()
  if (!id) {
    addError.value = t('admin.fulfillment.orderIdRequired')
    return
  }
  if (rows.value.some((r) => r.orderId === id)) {
    addError.value = t('admin.fulfillment.duplicateOrder')
    return
  }
  rows.value.push({
    orderId: id,
    type: newOrderType.value,
    status: 'pending',
    trackingInput: '',
    submitting: false,
    error: '',
    trackingNo: '',
    carrier: '',
    tracking: [],
    cdks: [],
  })
  newOrderId.value = ''
  addError.value = ''
}

/** 从列表移除一条未发货订单。 */
function removeOrder(orderId: string): void {
  rows.value = rows.value.filter((r) => r.orderId !== orderId)
}

/**
 * 实物发货：空物流编号阻止提交并提示补充（需求 14.3）；
 * 提交成功后置「已发货」并记录物流编号与物流明细（需求 8.2、8.3、14.1）。
 */
async function shipPhysical(row: FulfillmentRow): Promise<void> {
  const trackingNo = row.trackingInput.trim()
  if (!trackingNo) {
    row.error = t('admin.fulfillment.trackingRequired')
    return
  }
  row.error = ''
  row.submitting = true
  try {
    const result = await fulfillment.shipPhysical(row.orderId, { trackingNo })
    row.status = 'shipped'
    row.trackingNo = result.trackingNo
    row.carrier = result.tracking?.carrier ?? ''
    row.tracking = result.tracking?.nodes ?? []
  } catch (err) {
    const apiErr = toApiError(err)
    row.error = apiErr.message || t('errors.UNKNOWN')
  } finally {
    row.submitting = false
  }
}

/**
 * 虚拟发货：关联并交付 CDK，完成后置「已发货」并展示 CDK（需求 9.4、14.2）。
 */
async function shipVirtual(row: FulfillmentRow): Promise<void> {
  row.error = ''
  row.submitting = true
  try {
    const result = await fulfillment.shipVirtual(row.orderId)
    row.status = 'shipped'
    row.cdks = result.cdks ?? []
  } catch (err) {
    const apiErr = toApiError(err)
    row.error = apiErr.message || t('errors.UNKNOWN')
  } finally {
    row.submitting = false
  }
}
</script>

<style scoped>
.fulfillment-page {
  max-width: 820px;
  margin: 0 auto;
  padding: 1.5rem;
}

.page-header {
  margin-bottom: 1.5rem;
}

.page-title {
  margin: 0 0 0.35rem;
  font-size: 1.4rem;
  color: #2c3e50;
}

.page-subtitle {
  margin: 0;
  color: #888;
  font-size: 0.9rem;
}

.section-title {
  margin: 0 0 0.85rem;
  font-size: 1rem;
  color: #2c3e50;
  border-bottom: 1px solid #eee;
  padding-bottom: 0.4rem;
}

.add-panel,
.list-panel {
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  background: #fff;
  padding: 1.25rem;
  margin-bottom: 1.25rem;
}

.add-form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 1rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.field-inline {
  flex: 1;
  min-width: 220px;
}

.field-label {
  font-size: 0.82rem;
  color: #666;
}

.text-input {
  padding: 0.5rem 0.65rem;
  border: 1px solid #ccc;
  border-radius: 6px;
  font-size: 0.9rem;
  min-width: 220px;
}

.text-input:disabled {
  background: #f5f5f5;
  color: #999;
}

.btn-primary {
  padding: 0.55rem 1.1rem;
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

.field-error {
  color: #b71c1c;
  font-size: 0.85rem;
  margin: 0.6rem 0 0;
}

.state-hint {
  color: #888;
  font-size: 0.9rem;
  padding: 1rem 0;
  text-align: center;
}

.order-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.order-row {
  border: 1px solid #eee;
  border-radius: 8px;
  padding: 1rem;
  background: #fafafa;
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
}

.order-id {
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 0.95rem;
  color: #2c3e50;
  word-break: break-all;
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

.order-head-right {
  display: flex;
  align-items: center;
  gap: 0.75rem;
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

.btn-link-danger {
  background: none;
  border: none;
  color: #c62828;
  cursor: pointer;
  font-size: 0.82rem;
  padding: 0;
}

.ship-form {
  display: flex;
  align-items: flex-end;
  gap: 1rem;
  margin-top: 0.9rem;
  flex-wrap: wrap;
}

.ship-result {
  margin-top: 0.9rem;
  padding-top: 0.75rem;
  border-top: 1px dashed #e0e0e0;
}

.result-line {
  margin: 0 0 0.4rem;
  font-size: 0.9rem;
  color: #2c3e50;
}

.result-muted {
  color: #888;
}

.timeline {
  list-style: none;
  margin: 0.5rem 0 0;
  padding: 0;
}

.timeline-node {
  position: relative;
  display: flex;
  gap: 0.75rem;
  padding: 0 0 0.9rem 0.5rem;
  border-left: 2px solid #e0e0e0;
  margin-left: 0.35rem;
}

.timeline-node:last-child {
  border-left-color: transparent;
  padding-bottom: 0;
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

.timeline-status {
  margin: 0;
  font-size: 0.9rem;
  color: #2c3e50;
  font-weight: 600;
}

.timeline-desc {
  margin: 0.15rem 0 0;
  font-size: 0.85rem;
  color: #666;
}

.cdk-list {
  list-style: none;
  margin: 0.4rem 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.cdk-item {
  background: #f5f7fa;
  border: 1px dashed #cbd5e0;
  border-radius: 6px;
  padding: 0.55rem 0.75rem;
}

.cdk-item code {
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 0.95rem;
  color: #2c3e50;
  word-break: break-all;
}
</style>
