import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import * as cartApi from '@/api/cart'
import type { Cart, CartItem } from '@/api/cart'

/**
 * 购物车 Store。
 * - 购物车持久化于服务端（需求 6.6），本 Store 仅镜像服务端返回并派生合计。
 * - 所有写操作（增删改数量）都以服务端返回的最新购物车重算 items / totalPoints
 *   （recompute-on-response），保证小计与应付总额与服务端一致（需求 6.2、6.4、6.5）。
 */
export const useCartStore = defineStore('cart', () => {
  const items = ref<CartItem[]>([])
  const totalPoints = ref(0)
  const loading = ref(false)

  /** 购物车内商品总件数（各条目数量之和），用于导航角标等展示 */
  const itemCount = computed(() => items.value.reduce((sum, it) => sum + it.quantity, 0))

  /** 购物车是否为空 */
  const isEmpty = computed(() => items.value.length === 0)

  /** 用服务端返回的购物车覆盖本地镜像并重算合计 */
  function applyCart(cart: Cart): void {
    items.value = cart.items
    totalPoints.value = cart.totalPoints
  }

  /** 加载服务端购物车（需求 6.5、6.6） */
  async function load(): Promise<void> {
    loading.value = true
    try {
      applyCart(await cartApi.getCart())
    } finally {
      loading.value = false
    }
  }

  /** 加入商品（需求 6.1）；失败（如库存不足）向上抛出由调用方处理 */
  async function addItem(productId: string, quantity = 1): Promise<void> {
    applyCart(await cartApi.addItem(productId, quantity))
  }

  /** 调整某商品数量并实时重算总额（需求 6.2、6.3） */
  async function updateItem(productId: string, quantity: number): Promise<void> {
    applyCart(await cartApi.updateItem(productId, quantity))
  }

  /** 从购物车移除某商品并重算总额（需求 6.4） */
  async function removeItem(productId: string): Promise<void> {
    applyCart(await cartApi.removeItem(productId))
  }

  /** 清空本地镜像（例如登出时） */
  function reset(): void {
    items.value = []
    totalPoints.value = 0
  }

  return {
    // state
    items,
    totalPoints,
    loading,
    // getters
    itemCount,
    isEmpty,
    // actions
    load,
    addItem,
    updateItem,
    removeItem,
    reset,
  }
})
