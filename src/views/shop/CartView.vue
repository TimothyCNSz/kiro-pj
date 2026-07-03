<template>
  <div class="cart-page">
    <h1 class="cart-title">{{ t('cart.title') }}</h1>

    <!-- 全局提示（如库存不足，需求 6.3） -->
    <p v-if="errorMessage" class="alert alert-error">{{ errorMessage }}</p>

    <!-- 加载态 -->
    <p v-if="cart.loading && cart.isEmpty" class="hint">{{ t('common.loading') }}</p>

    <!-- 空购物车状态 -->
    <div v-else-if="cart.isEmpty" class="empty-state">
      <p class="empty-text">{{ t('cart.empty') }}</p>
      <RouterLink class="link" :to="{ name: 'Catalog' }">{{ t('cart.continueShopping') }}</RouterLink>
    </div>

    <!-- 购物车列表 -->
    <template v-else>
      <ul class="cart-list">
        <li v-for="item in cart.items" :key="item.productId" class="cart-item">
          <div class="item-main">
            <span class="item-name">{{ item.name }}</span>
            <span class="item-unit">
              {{ t('cart.unitPrice') }} {{ t('catalog.pricePoints', { points: item.unitPoints }) }}
            </span>
          </div>

          <!-- 数量调整（需求 6.2） -->
          <div class="item-qty">
            <button
              type="button"
              class="qty-btn"
              :disabled="isBusy(item.productId) || item.quantity <= 1"
              :aria-label="t('cart.quantity')"
              @click="changeQty(item, item.quantity - 1)"
            >
              −
            </button>
            <span class="qty-value">{{ item.quantity }}</span>
            <button
              type="button"
              class="qty-btn"
              :disabled="isBusy(item.productId)"
              :aria-label="t('cart.quantity')"
              @click="changeQty(item, item.quantity + 1)"
            >
              +
            </button>
          </div>

          <!-- 小计（需求 6.5） -->
          <span class="item-subtotal">{{ t('catalog.pricePoints', { points: item.subtotal }) }}</span>

          <!-- 移除（需求 6.4） -->
          <button
            type="button"
            class="remove-btn"
            :disabled="isBusy(item.productId)"
            @click="remove(item)"
          >
            {{ t('cart.remove') }}
          </button>
        </li>
      </ul>

      <!-- 应付积分总额（需求 6.5） -->
      <div class="cart-summary">
        <span class="summary-label">{{ t('cart.payable') }}</span>
        <span class="summary-total">{{ t('catalog.pricePoints', { points: cart.totalPoints }) }}</span>
      </div>

      <div class="cart-actions">
        <RouterLink class="btn-primary" :to="{ name: 'Checkout' }">{{ t('cart.checkout') }}</RouterLink>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useCartStore } from '@/stores/cart'
import type { CartItem } from '@/api/cart'
import { toApiError, isInsufficientStock } from '@/api/cart'

const { t } = useI18n()
const cart = useCartStore()

const errorMessage = ref('')
// 正在进行写操作的商品 id 集合，用于禁用其行内按钮，避免并发重复提交
const busy = ref<Set<string>>(new Set())

function isBusy(productId: string): boolean {
  return busy.value.has(productId)
}

function setBusy(productId: string, value: boolean): void {
  const next = new Set(busy.value)
  if (value) next.add(productId)
  else next.delete(productId)
  busy.value = next
}

function handleError(err: unknown): void {
  const apiErr = toApiError(err)
  if (isInsufficientStock(apiErr)) {
    // 超库存 / 零库存：提示库存不足并阻止以超库存数量结算（需求 6.3）
    errorMessage.value = apiErr.message || t('errors.INSUFFICIENT_STOCK')
  } else {
    errorMessage.value = apiErr.message || t('errors.UNKNOWN')
  }
}

/** 调整数量（需求 6.2、6.3） */
async function changeQty(item: CartItem, quantity: number): Promise<void> {
  if (quantity < 1 || quantity === item.quantity) return
  errorMessage.value = ''
  setBusy(item.productId, true)
  try {
    await cart.updateItem(item.productId, quantity)
  } catch (err) {
    handleError(err)
  } finally {
    setBusy(item.productId, false)
  }
}

/** 移除条目（需求 6.4） */
async function remove(item: CartItem): Promise<void> {
  errorMessage.value = ''
  setBusy(item.productId, true)
  try {
    await cart.removeItem(item.productId)
  } catch (err) {
    handleError(err)
  } finally {
    setBusy(item.productId, false)
  }
}

onMounted(async () => {
  try {
    await cart.load()
  } catch (err) {
    handleError(err)
  }
})
</script>

<style scoped>
.cart-page {
  max-width: 760px;
  margin: 0 auto;
  padding: 2rem 1rem;
}

.cart-title {
  margin: 0 0 1rem;
  font-size: 1.5rem;
  color: #2c3e50;
}

.hint {
  color: #666;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  padding: 3rem 1rem;
  color: #666;
}

.empty-text {
  margin: 0;
  font-size: 1rem;
}

.cart-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.cart-item {
  display: grid;
  grid-template-columns: 1fr auto auto auto;
  align-items: center;
  gap: 1rem;
  padding: 0.85rem 1rem;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  background: #fff;
}

.item-main {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
}

.item-name {
  font-weight: 600;
  color: #2c3e50;
}

.item-unit {
  font-size: 0.8rem;
  color: #888;
}

.item-qty {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.qty-btn {
  width: 1.9rem;
  height: 1.9rem;
  border: 1px solid #ccc;
  border-radius: 6px;
  background: #f7f7f7;
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
}

.qty-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.qty-value {
  min-width: 1.5rem;
  text-align: center;
}

.item-subtotal {
  min-width: 5rem;
  text-align: right;
  color: #2c3e50;
}

.remove-btn {
  border: none;
  background: transparent;
  color: #b71c1c;
  cursor: pointer;
  font-size: 0.875rem;
}

.remove-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cart-summary {
  display: flex;
  align-items: baseline;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 1.25rem;
  padding-top: 1rem;
  border-top: 1px solid #eee;
}

.summary-label {
  color: #555;
}

.summary-total {
  font-size: 1.35rem;
  font-weight: 700;
  color: #42b983;
}

.cart-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 1rem;
}

.btn-primary {
  display: inline-block;
  padding: 0.65rem 1.5rem;
  font-size: 1rem;
  border: none;
  border-radius: 6px;
  background: #42b983;
  color: #fff;
  text-decoration: none;
  cursor: pointer;
}

.alert {
  margin: 0 0 1rem;
  padding: 0.6rem 0.75rem;
  border-radius: 6px;
  font-size: 0.875rem;
}

.alert-error {
  background: #fdecea;
  color: #b71c1c;
}

.link {
  color: #42b983;
  text-decoration: none;
}

.link:hover {
  text-decoration: underline;
}
</style>
