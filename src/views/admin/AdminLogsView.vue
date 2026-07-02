<template>
  <div class="logs-page">
    <header class="logs-header">
      <h1 class="logs-title">{{ t('admin.auditLog') }}</h1>
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

    <!-- 空状态 -->
    <p v-else-if="items.length === 0" class="state-hint">{{ t('admin.logEmpty') }}</p>

    <!-- 操作日志表格：服务端已按时间从新到旧排序（需求 16.2） -->
    <table v-else class="logs-table">
      <thead>
        <tr>
          <th>{{ t('admin.logColumns.actor') }}</th>
          <th>{{ t('admin.logColumns.action') }}</th>
          <th>{{ t('admin.logColumns.target') }}</th>
          <th>{{ t('admin.logColumns.time') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="log in items" :key="log.id">
          <td class="cell-actor" :title="log.actorId">{{ log.actorId }}</td>
          <td>
            <span class="action-badge">{{ actionLabel(log.action) }}</span>
          </td>
          <td class="cell-target">{{ targetSummary(log) }}</td>
          <td class="cell-time">{{ formatDateTime(log.createdAt) }}</td>
        </tr>
      </tbody>
    </table>

    <!-- 分页 -->
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
import { useI18n } from 'vue-i18n'
import { logs, type OperationLog, type OperationAction } from '@/api/admin'
import { toApiError } from '@/api/cart'
import { formatDate } from '@/utils'

const { t } = useI18n()

const PAGE_SIZE = 20

const items = ref<OperationLog[]>([])
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
    const data = await logs.list({ page: next, pageSize: PAGE_SIZE })
    items.value = data.list
    total.value = data.total
    page.value = data.page || next
  } catch (err) {
    const apiErr = toApiError(err)
    errorMessage.value = apiErr.message || t('errors.UNKNOWN')
  } finally {
    loading.value = false
  }
}

/** 操作类型本地化文案；未知类型回退为原始标识符 */
function actionLabel(action: OperationAction): string {
  const key = `admin.logActions.${action}`
  const label = t(key)
  return label === key ? action : label
}

/** 操作对象摘要：类型 + 标识 */
function targetSummary(log: OperationLog): string {
  return `${log.targetType} · ${log.targetId}`
}

function formatDateTime(iso: string): string {
  return formatDate(iso, 'YYYY-MM-DD HH:mm:ss')
}

onMounted(() => load(1))
</script>

<style scoped>
.logs-page {
  max-width: 960px;
  margin: 0 auto;
  padding: 1.5rem;
}

.logs-header {
  margin-bottom: 1.25rem;
}

.logs-title {
  margin: 0;
  font-size: 1.5rem;
  color: #2c3e50;
}

.logs-table {
  width: 100%;
  border-collapse: collapse;
  background: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  overflow: hidden;
}

.logs-table th,
.logs-table td {
  padding: 0.7rem 1rem;
  text-align: left;
  font-size: 0.9rem;
  border-bottom: 1px solid #eee;
}

.logs-table th {
  background: #f7f9fa;
  color: #555;
  font-weight: 600;
}

.logs-table tbody tr:last-child td {
  border-bottom: none;
}

.cell-actor,
.cell-target {
  max-width: 220px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #2c3e50;
}

.cell-time {
  color: #888;
  white-space: nowrap;
}

.action-badge {
  display: inline-block;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  background: #e3f2fd;
  color: #0d47a1;
  font-size: 0.8rem;
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
