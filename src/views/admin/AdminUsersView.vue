<template>
  <div class="admin-users-page">
    <header class="page-header">
      <h1 class="page-title">{{ t('admin.usersTitle') }}</h1>

      <!-- 关键字（邮箱）搜索（需求 24.2） -->
      <form class="search-bar" @submit.prevent="onSearch">
        <input
          v-model.trim="keywordInput"
          type="search"
          class="search-input"
          :placeholder="t('admin.employeeSearchPlaceholder')"
          :aria-label="t('admin.employeeSearchPlaceholder')"
        />
        <button class="btn-primary" type="submit">{{ t('common.search') }}</button>
        <button v-if="isSearching" class="btn-secondary" type="button" @click="onClear">
          {{ t('common.reset') }}
        </button>
      </form>
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

    <!-- 空状态：搜索无匹配（需求 24.3） -->
    <p v-else-if="rows.length === 0" class="state-hint">{{ t('admin.employeeEmpty') }}</p>

    <!-- 员工列表（需求 24.1）：邮箱 / 角色 / 状态 / 余额 + 单选/多选 -->
    <template v-else>
      <table class="user-table">
        <thead>
          <tr>
            <th class="col-select">
              <input
                type="checkbox"
                :checked="allSelectedOnPage"
                :aria-label="t('admin.selectAll')"
                @change="toggleSelectAll"
              />
            </th>
            <th class="col-email">{{ t('admin.colEmail') }}</th>
            <th class="col-role">{{ t('admin.colRole') }}</th>
            <th class="col-status">{{ t('admin.colStatus') }}</th>
            <th class="col-balance">{{ t('admin.colBalance') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="row.userId"
            :class="{ 'is-selected': isSelected(row.userId) }"
            @click="toggleRow(row)"
          >
            <td class="col-select" @click.stop>
              <input
                type="checkbox"
                :checked="isSelected(row.userId)"
                :aria-label="row.email"
                @change="toggleRow(row)"
              />
            </td>
            <td class="col-email">{{ row.email }}</td>
            <td class="col-role">{{ roleLabel(row.role) }}</td>
            <td class="col-status">
              <span class="status-badge" :class="statusClass(row.status)">
                {{ statusLabel(row.status) }}
              </span>
            </td>
            <td class="col-balance">{{ row.balance }}</td>
          </tr>
        </tbody>
      </table>

      <!-- 分页（需求 24.4） -->
      <nav v-if="totalPages > 1" class="pagination">
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
    </template>

    <!-- 选择结果操作条：转入积分调整流程（需求 24.5） -->
    <div v-if="pointsStore.hasSelection" class="selection-bar">
      <span class="selection-count">
        {{ t('admin.selectedCount', { count: pointsStore.count }) }}
      </span>
      <button class="btn-primary" type="button" @click="proceedToAdjust">
        {{ t('admin.proceedAdjust') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { users, type AdminUserRow, type Role, type UserStatus } from '@/api/admin'
import { toApiError } from '@/api/cart'
import { useAdminPointsStore } from '@/stores/adminPoints'

const { t } = useI18n()
const router = useRouter()
const pointsStore = useAdminPointsStore()

const PAGE_SIZE = 10

const rows = ref<AdminUserRow[]>([])
const page = ref(1)
const total = ref(0)
const keyword = ref('')
const keywordInput = ref('')
const loading = ref(false)
const errorMessage = ref('')

/** 跨页保留的选中集合：userId → 员工行 */
const selectedMap = ref<Map<string, AdminUserRow>>(new Map())

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const isSearching = computed(() => keyword.value.length > 0)

/** 当前页是否已全部选中（用于全选框状态） */
const allSelectedOnPage = computed(
  () => rows.value.length > 0 && rows.value.every((r) => selectedMap.value.has(r.userId)),
)

function isSelected(userId: string): boolean {
  return selectedMap.value.has(userId)
}

async function load(target = 1): Promise<void> {
  const next = Math.max(1, target)
  loading.value = true
  errorMessage.value = ''
  try {
    const data = await users.list({
      q: keyword.value || undefined,
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

async function onSearch(): Promise<void> {
  keyword.value = keywordInput.value
  await load(1)
}

async function onClear(): Promise<void> {
  keywordInput.value = ''
  keyword.value = ''
  await load(1)
}

/** 切换单行选中状态（支持单选/多选，需求 24.5） */
function toggleRow(row: AdminUserRow): void {
  const map = new Map(selectedMap.value)
  if (map.has(row.userId)) {
    map.delete(row.userId)
  } else {
    map.set(row.userId, row)
  }
  selectedMap.value = map
  syncStore()
}

/** 当前页全选/取消全选 */
function toggleSelectAll(): void {
  const map = new Map(selectedMap.value)
  if (allSelectedOnPage.value) {
    for (const r of rows.value) map.delete(r.userId)
  } else {
    for (const r of rows.value) map.set(r.userId, r)
  }
  selectedMap.value = map
  syncStore()
}

/** 将选择同步到共享 Store，供积分调整页读取 */
function syncStore(): void {
  pointsStore.setSelection([...selectedMap.value.values()])
}

/** 转入积分调整流程：单选/多选均由目标 Store 承载（需求 24.5、13） */
function proceedToAdjust(): void {
  if (!pointsStore.hasSelection) return
  router.push({ name: 'AdminPoints' })
}

function roleLabel(role: Role): string {
  return role === 'admin' ? t('admin.roleAdmin') : t('admin.roleEmployee')
}

function statusLabel(status: UserStatus): string {
  return status === 'active' ? t('admin.statusActive') : t('admin.statusPending')
}

function statusClass(status: UserStatus): string {
  return status === 'active' ? 'is-active' : 'is-pending'
}

onMounted(() => {
  // 进入列表时清空历史选择，避免陈旧目标残留
  pointsStore.clear()
  load(1)
})
</script>

<style scoped>
.admin-users-page {
  max-width: 960px;
  margin: 0 auto;
  padding: 1.5rem;
}

.page-header {
  display: flex;
  flex-wrap: wrap;
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

.search-bar {
  display: flex;
  gap: 0.5rem;
}

.search-input {
  padding: 0.5rem 0.75rem;
  font-size: 0.95rem;
  border: 1px solid #ccc;
  border-radius: 6px;
  min-width: 220px;
}

.search-input:focus {
  outline: none;
  border-color: #42b983;
}

.user-table {
  width: 100%;
  border-collapse: collapse;
  background: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  overflow: hidden;
}

.user-table th,
.user-table td {
  padding: 0.7rem 0.9rem;
  text-align: left;
  border-bottom: 1px solid #eee;
  font-size: 0.92rem;
}

.user-table th {
  background: #f7f9fa;
  color: #55606a;
  font-weight: 600;
}

.user-table tbody tr {
  cursor: pointer;
  transition: background 0.15s;
}

.user-table tbody tr:hover {
  background: #f5faf7;
}

.user-table tbody tr.is-selected {
  background: #e8f5e9;
}

.col-select {
  width: 40px;
  text-align: center;
}

.col-balance {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.status-badge {
  font-size: 0.78rem;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
}

.status-badge.is-active {
  background: #e8f5e9;
  color: #1b5e20;
}

.status-badge.is-pending {
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

.selection-bar {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-top: 1.5rem;
  padding: 0.9rem 1.1rem;
  background: #fff;
  border: 1px solid #d5e8dd;
  border-radius: 8px;
  box-shadow: 0 -2px 12px rgba(0, 0, 0, 0.06);
}

.selection-count {
  font-size: 0.95rem;
  color: #2c3e50;
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

.btn-secondary {
  background: #e0e0e0;
  color: #333;
}

.btn-secondary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
