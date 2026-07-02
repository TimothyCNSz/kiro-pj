<template>
  <div class="admin-points-page">
    <header class="page-header">
      <h1 class="page-title">
        {{ pointsStore.isSingle ? t('admin.adjustPoints') : t('admin.batchAdjustPoints') }}
      </h1>
      <button class="btn-secondary" type="button" @click="backToUsers">
        {{ t('admin.backToUsers') }}
      </button>
    </header>

    <!-- 无选择：引导返回员工列表（需求 24.5） -->
    <p v-if="!pointsStore.hasSelection" class="state-hint">{{ t('admin.noSelection') }}</p>

    <template v-else>
      <!-- 目标员工（需求 24.5） -->
      <section class="panel">
        <h2 class="panel-title">
          {{ t('admin.targetEmployees') }}
          <span class="muted">（{{ pointsStore.count }}）</span>
        </h2>
        <ul class="target-list">
          <li v-for="u in pointsStore.selected" :key="u.userId" class="target-item">
            <span class="target-email">{{ u.email }}</span>
            <span class="target-balance">{{ t('admin.colBalance') }}: {{ u.balance }}</span>
          </li>
        </ul>
      </section>

      <!-- 调整表单（需求 13.1、13.2、13.5） -->
      <section class="panel">
        <form class="adjust-form" @submit.prevent="onSubmit">
          <div class="field">
            <span class="field-label">{{ t('admin.operationType') }}</span>
            <div class="radio-group">
              <label class="radio">
                <input v-model="operation" type="radio" value="grant" />
                <span>{{ t('admin.grantPoints') }}</span>
              </label>
              <label class="radio">
                <input v-model="operation" type="radio" value="deduct" />
                <span>{{ t('admin.deductPoints') }}</span>
              </label>
            </div>
          </div>

          <div class="field">
            <label class="field-label" for="adjust-amount">{{ t('admin.adjustAmount') }}</label>
            <input
              id="adjust-amount"
              v-model.number="amount"
              type="number"
              min="1"
              step="1"
              class="text-input"
              :placeholder="t('admin.amountPlaceholder')"
            />
          </div>

          <div class="field">
            <label class="field-label" for="adjust-note">
              {{ t('admin.adjustReason') }}
              <span class="muted">（{{ t('common.optional') }}）</span>
            </label>
            <input
              id="adjust-note"
              v-model.trim="note"
              type="text"
              class="text-input"
              :placeholder="t('admin.adjustReasonPlaceholder')"
            />
          </div>

          <!-- 校验/错误提示 -->
          <p v-if="formError" class="form-error">{{ formError }}</p>

          <div class="form-actions">
            <button class="btn-primary" type="submit" :disabled="submitting">
              {{ submitting ? t('common.submitting') : t('admin.confirmAdjust') }}
            </button>
          </div>
        </form>
      </section>

      <!-- 单个调整结果（需求 13.1、13.3） -->
      <section v-if="singleResult" class="panel result-panel">
        <p class="result-success">
          {{ t('admin.adjustSuccess') }} · {{ t('admin.newBalance') }}:
          {{ singleResult.newBalance }}
        </p>
      </section>

      <!-- 批量调整结果：部分成功明细（需求 13.4） -->
      <section v-if="batchResult" class="panel result-panel">
        <h2 class="panel-title">{{ t('admin.batchResultTitle') }}</h2>
        <p class="result-summary">
          <span class="ok">{{ t('admin.batchResultSuccess', { count: batchResult.succeeded.length }) }}</span>
          <span class="skip">{{ t('admin.batchResultSkipped', { count: batchResult.skipped.length }) }}</span>
        </p>

        <div v-if="batchResult.succeeded.length > 0" class="result-block">
          <h3 class="result-block-title">{{ t('admin.batchSucceededTitle') }}</h3>
          <ul class="result-detail">
            <li v-for="s in batchResult.succeeded" :key="s.userId" class="detail-row is-ok">
              <span class="detail-email">{{ emailOf(s.userId) }}</span>
              <span class="detail-value">{{ t('admin.newBalance') }}: {{ s.newBalance }}</span>
            </li>
          </ul>
        </div>

        <div v-if="batchResult.skipped.length > 0" class="result-block">
          <h3 class="result-block-title">{{ t('admin.batchSkippedTitle') }}</h3>
          <ul class="result-detail">
            <li v-for="s in batchResult.skipped" :key="s.userId" class="detail-row is-skip">
              <span class="detail-email">{{ emailOf(s.userId) }}</span>
              <span class="detail-value">{{ t('admin.skipReasonInsufficient') }}</span>
            </li>
          </ul>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { points, type AdjustPointsResult, type BatchAdjustResult } from '@/api/admin'
import { toApiError } from '@/api/cart'
import { useAdminPointsStore } from '@/stores/adminPoints'

const { t } = useI18n()
const router = useRouter()
const pointsStore = useAdminPointsStore()

type Operation = 'grant' | 'deduct'

const operation = ref<Operation>('grant')
const amount = ref<number | null>(null)
const note = ref('')
const submitting = ref(false)
const formError = ref('')

const singleResult = ref<AdjustPointsResult | null>(null)
const batchResult = ref<BatchAdjustResult | null>(null)

/** 表单归一化的正整数数量（非法时为 null） */
const normalizedAmount = computed(() => {
  const v = amount.value
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) return null
  return v
})

/** userId → 邮箱，用于批量结果明细展示 */
function emailOf(userId: string): string {
  return pointsStore.selected.find((u) => u.userId === userId)?.email ?? userId
}

function backToUsers(): void {
  router.push({ name: 'AdminUsers' })
}

/** 提交单个/批量积分调整（正=发放，负=扣除，需求 13.1–13.4） */
async function onSubmit(): Promise<void> {
  formError.value = ''
  singleResult.value = null
  batchResult.value = null

  const qty = normalizedAmount.value
  if (qty === null) {
    formError.value = t('admin.amountInvalid')
    return
  }

  const delta = operation.value === 'grant' ? qty : -qty
  const trimmedNote = note.value.trim() || undefined

  // 单个扣除的前置校验：扣除后余额 < 0 则阻止并提示余额不足（需求 13.3）
  if (pointsStore.isSingle && operation.value === 'deduct') {
    const target = pointsStore.selected[0]
    if (target.balance + delta < 0) {
      formError.value = t('admin.insufficientBalance')
      return
    }
  }

  submitting.value = true
  try {
    if (pointsStore.isSingle) {
      singleResult.value = await points.adjust({
        userId: pointsStore.selected[0].userId,
        delta,
        note: trimmedNote,
      })
    } else {
      batchResult.value = await points.batchAdjust({
        userIds: pointsStore.userIds,
        delta,
        note: trimmedNote,
      })
    }
  } catch (err) {
    const apiErr = toApiError(err)
    // 后端不透支校验兜底：单个扣除被拒时提示余额不足（需求 13.3）
    if (apiErr.code === 'INSUFFICIENT_BALANCE') {
      formError.value = t('admin.insufficientBalance')
    } else {
      formError.value = apiErr.message || t('errors.UNKNOWN')
    }
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.admin-points-page {
  max-width: 720px;
  margin: 0 auto;
  padding: 1.5rem;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.5rem;
}

.page-title {
  margin: 0;
  font-size: 1.5rem;
  color: #2c3e50;
}

.panel {
  background: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  padding: 1.1rem 1.2rem;
  margin-bottom: 1.25rem;
}

.panel-title {
  margin: 0 0 0.8rem;
  font-size: 1.05rem;
  color: #2c3e50;
}

.muted {
  color: #999;
  font-weight: 400;
  font-size: 0.9rem;
}

.target-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-height: 220px;
  overflow-y: auto;
}

.target-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.45rem 0.6rem;
  background: #f7f9fa;
  border-radius: 6px;
}

.target-email {
  color: #2c3e50;
}

.target-balance {
  color: #666;
  font-size: 0.88rem;
  font-variant-numeric: tabular-nums;
}

.adjust-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.field-label {
  font-size: 0.9rem;
  color: #55606a;
  font-weight: 600;
}

.radio-group {
  display: flex;
  gap: 1.25rem;
}

.radio {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  cursor: pointer;
}

.text-input {
  padding: 0.55rem 0.75rem;
  font-size: 0.95rem;
  border: 1px solid #ccc;
  border-radius: 6px;
}

.text-input:focus {
  outline: none;
  border-color: #42b983;
}

.form-error {
  margin: 0;
  color: #b71c1c;
  font-size: 0.9rem;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
}

.result-panel {
  border-color: #d5e8dd;
}

.result-success {
  margin: 0;
  color: #1b5e20;
  font-weight: 600;
}

.result-summary {
  display: flex;
  gap: 1rem;
  margin: 0 0 0.8rem;
  font-weight: 600;
}

.result-summary .ok {
  color: #1b5e20;
}

.result-summary .skip {
  color: #e65100;
}

.result-block {
  margin-top: 0.8rem;
}

.result-block-title {
  margin: 0 0 0.5rem;
  font-size: 0.92rem;
  color: #55606a;
}

.result-detail {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.detail-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.4rem 0.6rem;
  border-radius: 6px;
  font-size: 0.9rem;
}

.detail-row.is-ok {
  background: #e8f5e9;
  color: #1b5e20;
}

.detail-row.is-skip {
  background: #fff3e0;
  color: #e65100;
}

.detail-value {
  font-variant-numeric: tabular-nums;
}

.state-hint {
  padding: 2rem 0;
  color: #666;
  text-align: center;
}

.btn-primary,
.btn-secondary {
  padding: 0.5rem 1rem;
  font-size: 0.95rem;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.btn-primary {
  background: #42b983;
  color: #fff;
}

.btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-secondary {
  background: #e0e0e0;
  color: #333;
}
</style>
