import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as catalogApi from '@/api/catalog'
import type { ProductDetail, ProductListItem } from '@/api/catalog'

const DEFAULT_PAGE_SIZE = 12

/**
 * 商品目录 Store：缓存商品列表、搜索关键字/结果、分页与当前商品详情，
 * 并暴露加载/空状态供视图层渲染（需求 4.1、4.3、4.4、4.5）。
 *
 * 说明：列表与搜索共用同一份 `items`/分页状态——`keyword` 为空时走列表接口，
 * 非空时走搜索接口，从而统一分页与空状态处理。
 */
export const useCatalogStore = defineStore('catalog', () => {
  // 列表 / 搜索共享状态
  const items = ref<ProductListItem[]>([])
  const keyword = ref('')
  const page = ref(1)
  const pageSize = ref(DEFAULT_PAGE_SIZE)
  const total = ref(0)
  const listLoading = ref(false)
  const listError = ref('')

  // 商品详情状态
  const current = ref<ProductDetail | null>(null)
  const detailLoading = ref(false)
  const detailError = ref('')

  const totalPages = computed(() =>
    pageSize.value > 0 ? Math.max(1, Math.ceil(total.value / pageSize.value)) : 1,
  )
  /** 是否处于搜索模式（关键字非空） */
  const isSearching = computed(() => keyword.value.trim().length > 0)
  /** 加载完成后无任何商品 */
  const isEmpty = computed(() => !listLoading.value && items.value.length === 0)
  /** 搜索无匹配结果（需求 4.4：展示“未找到相关商品”） */
  const isSearchEmpty = computed(() => isSearching.value && isEmpty.value)

  /** 拉取当前页（依据 keyword 选择列表或搜索接口） */
  async function load(targetPage: number = page.value): Promise<void> {
    listLoading.value = true
    listError.value = ''
    try {
      const q = keyword.value.trim()
      const result = q
        ? await catalogApi.searchProducts({ q, page: targetPage, pageSize: pageSize.value })
        : await catalogApi.listProducts({ page: targetPage, pageSize: pageSize.value })
      items.value = result.list
      total.value = result.total
      page.value = result.page || targetPage
      if (result.pageSize) pageSize.value = result.pageSize
    } catch (err) {
      items.value = []
      total.value = 0
      listError.value = err instanceof Error ? err.message : '加载商品失败，请稍后重试'
    } finally {
      listLoading.value = false
    }
  }

  /** 提交搜索：设置关键字并回到第 1 页（需求 4.3） */
  async function search(term: string): Promise<void> {
    keyword.value = term
    await load(1)
  }

  /** 清空搜索并回到完整列表 */
  async function clearSearch(): Promise<void> {
    keyword.value = ''
    await load(1)
  }

  /** 跳转到指定页（受总页数约束） */
  async function goToPage(target: number): Promise<void> {
    const clamped = Math.min(Math.max(1, target), totalPages.value)
    await load(clamped)
  }

  /** 加载商品详情（需求 4.5） */
  async function loadDetail(id: string): Promise<void> {
    detailLoading.value = true
    detailError.value = ''
    current.value = null
    try {
      current.value = await catalogApi.getProduct(id)
    } catch (err) {
      detailError.value = err instanceof Error ? err.message : '加载商品详情失败，请稍后重试'
    } finally {
      detailLoading.value = false
    }
  }

  return {
    // state
    items,
    keyword,
    page,
    pageSize,
    total,
    listLoading,
    listError,
    current,
    detailLoading,
    detailError,
    // getters
    totalPages,
    isSearching,
    isEmpty,
    isSearchEmpty,
    // actions
    load,
    search,
    clearSearch,
    goToPage,
    loadDetail,
  }
})
