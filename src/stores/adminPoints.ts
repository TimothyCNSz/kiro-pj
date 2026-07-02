import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { AdminUserRow } from '@/api/admin'

/**
 * 员工列表 → 积分管理流程的选择传递 Store（需求 24.5）。
 *
 * `AdminUsersView` 在管理员勾选一个或多个员工后，将所选员工写入本 Store，
 * 再跳转至 `AdminPointsView`；后者据此决定走单个调整（单选）或批量调整（多选），
 * 并可展示目标员工的邮箱与当前余额等上下文。仅存于内存，刷新后需重新选择。
 */
export const useAdminPointsStore = defineStore('adminPoints', () => {
  /** 当前选中的目标员工（只读快照，用于积分调整流程展示与提交） */
  const selected = ref<AdminUserRow[]>([])

  /** 选中的员工数量 */
  const count = computed(() => selected.value.length)

  /** 是否为单个调整（恰好选中 1 人） */
  const isSingle = computed(() => selected.value.length === 1)

  /** 是否有任何选中项 */
  const hasSelection = computed(() => selected.value.length > 0)

  /** 选中员工的 userId 集合，供积分调整接口使用 */
  const userIds = computed(() => selected.value.map((u) => u.userId))

  /** 写入选中的目标员工（覆盖式），作为传入积分流程的目标 */
  function setSelection(rows: AdminUserRow[]): void {
    selected.value = [...rows]
  }

  /** 清空选择（离开积分流程或完成后调用） */
  function clear(): void {
    selected.value = []
  }

  return {
    selected,
    count,
    isSingle,
    hasSelection,
    userIds,
    setSelection,
    clear,
  }
})
