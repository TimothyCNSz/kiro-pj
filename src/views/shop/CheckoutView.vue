<template>
  <div class="checkout-page">
    <h1 class="checkout-title">
      {{ mode === 'instant' ? t('checkout.instantTitle') : t('checkout.title') }}
    </h1>

    <!-- 加载态 -->
    <p v-if="loading" class="state-hint">{{ t('common.loading') }}</p>

    <!-- 加载错误 -->
    <div v-else-if="loadError" class="state-hint state-error">
      <span>{{ loadError }}</span>
      <BaseButton variant="secondary" type="button" @click="reload">
        {{ t('common.retry') }}
      </BaseButton>
    </div>

    <!-- 兑换成功 -->
    <div v-else-if="succeeded" class="success-state">
      <p class="success-text">✅ {{ t('checkout.redeemSuccess') }}</p>
      <div class="success-actions">
        <RouterLink class="link" :to="{ name: 'Catalog' }">
          {{ t('cart.continueShopping') }}
        </RouterLink>
        <RouterLink v-if="hasHistoryRoute" class="link" :to="{ name: historyRouteName }">
          {{ t('checkout.viewOrders') }}
        </RouterLink>
      </div>
    </div>

    <!-- 空购物车（仅购物车模式） -->
    <div v-else-if="items.length === 0" class="empty-state">
      <p class="empty-text">{{ t('cart.empty') }}</p>
      <RouterLink class="link" :to="{ name: 'Catalog' }">{{ t('cart.emptyHint') }}</RouterLink>
    </div>

    <template v-else>
      <!-- 全局错误提示（积分不足 / 库存不足 / 地址缺失等，需求 5.4、5.5、7.3） -->
      <p v-if="errorMessage" class="alert alert-error">{{ errorMessage }}</p>

      <!-- 订单摘要（需求 7.1） -->
      <section class="summary-section">
        <h2 class="section-title">{{ t('checkout.orderSummary') }}</h2>
        <ul class="summary-list">
          <li v-for="item in items" :key="item.productId" class="summary-item">
            <span class="item-name">{{ item.name }}</span>
            <span class="item-qty">× {{ item.quantity }}</span>
            <span class="item-subtotal">
              {{ t('catalog.pricePoints', { points: item.subtotal }) }}
            </span>
          </li>
        </ul>
        <div class="summary-total">
          <span class="total-label">{{ t('checkout.pointsRequired') }}</span>
          <span class="total-value">{{ t('catalog.pricePoints', { points: totalPoints }) }}</span>
        </div>
      </section>

      <!-- 配送地址（含实物商品时必填，需求 7.3） -->
      <section v-if="showAddress" class="address-section">
        <h2 class="section-title">{{ t('checkout.shippingAddress') }}</h2>
        <AddressForm ref="addressFormRef" v-model="address" :required="requireAddress" />
      </section>

      <div class="checkout-actions">
        <RouterLink
          v-if="mode === 'cart'"
          class="btn-secondary"
          :to="{ name: 'Cart' }"
        >
          {{ t('checkout.backToCart') }}
        </RouterLink>
        <BaseButton
          variant="primary"
          type="button"
          :loading="submitting"
          @click="openConfirm"
        >
          {{ t('checkout.confirmRedeem') }}
        </BaseButton>
      </div>
    </template>

    <!-- 二次确认弹窗（需求 7.1、7.2）；取消不产生副作用（需求 7.6） -->
    <ConfirmDialog
      :visible="confirmVisible"
      :title="t('checkout.confirmTitle')"
      :message="t('checkout.confirmMessage')"
      :confirm-text="t('checkout.confirmRedeem')"
      :loading="submitting"
      @confirm="onConfirm"
      @cancel="onCancel"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import BaseButton from '@/components/BaseButton.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import AddressForm from '@/components/AddressForm.vue'
import { useCartStore } from '@/stores/cart'
import { getProduct } from '@/api/catalog'
import * as redemptionApi from '@/api/redemption'
import type { Address } from '@/api/redemption'

/**
 * 兑换（结算）视图（需求 7）。
 *
 * 支持两种入口：
 * - 购物车结算（默认）：汇总购物车所有商品结算（需求 7.1）。
 * - 立即兑换：通过 query `?productId=&quantity=` 进入，对单件商品发起兑换（需求 7.2）。
 *
 * 两种入口共用「二次确认 + 地址（实物必填）」流程；确认后调用后端，
 * 并将 INSUFFICIENT_POINTS / INSUFFICIENT_STOCK / ADDRESS_REQUIRED 映射为本地化提示。
 */

interface LineItem {
  productId: string
  name: string
  quantity: number
  subtotal: number
}

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const cart = useCartStore()

const mode = ref<'cart' | 'instant'>('cart')
const loading = ref(true)
const loadError = ref('')
const submitting = ref(false)
const succeeded = ref(false)
const errorMessage = ref('')
const confirmVisible = ref(false)

// 立即兑换模式下的目标
const instantProductId = ref('')
const instantQuantity = ref(1)

const items = ref<LineItem[]>([])
const totalPoints = ref(0)

// 是否包含实物商品（决定地址是否必填，需求 7.3）
const hasPhysical = ref(false)
// 后端返回 ADDRESS_REQUIRED 后强制要求地址（需求 7.3）
const addressRequiredByServer = ref(false)

const address = ref<Address>({ recipient: '', phone: '', detail: '' })
const addressFormRef = ref<InstanceType<typeof AddressForm> | null>(null)

/** 是否必须填写地址：本地检测到实物商品，或后端要求 */
const requireAddress = computed(() => hasPhysical.value || addressRequiredByServer.value)
/** 是否展示地址表单：必填时展示；未知类型（购物车）也展示为可选，便于按需填写 */
const showAddress = computed(() => requireAddress.value || mode.value === 'cart')

// 兑换记录路由（若已存在则提供入口，向后兼容尚未实现的历史页）
const historyRouteName = 'History'
const hasHistoryRoute = computed(() => router.hasRoute(historyRouteName))

/** 载入结算数据 */
async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  succeeded.value = false
  errorMessage.value = ''
  addressRequiredByServer.value = false

  const qProductId = route.query.productId
  const qQuantity = route.query.quantity

  try {
    if (typeof qProductId === 'string' && qProductId) {
      // 立即兑换模式（需求 7.2）
      mode.value = 'instant'
      instantProductId.value = qProductId
      const parsed = typeof qQuantity === 'string' ? parseInt(qQuantity, 10) : 1
      instantQuantity.value = Number.isFinite(parsed) && parsed > 0 ? parsed : 1

      const product = await getProduct(qProductId)
      hasPhysical.value = product.type === 'physical'
      const subtotal = product.pointsCost * instantQuantity.value
      items.value = [
        {
          productId: product.id,
          name: product.name,
          quantity: instantQuantity.value,
          subtotal,
        },
      ]
      totalPoints.value = subtotal
    } else {
      // 购物车结算模式（需求 7.1）
      mode.value = 'cart'
      await cart.load()
      items.value = cart.items.map((it) => ({
        productId: it.productId,
        name: it.name,
        quantity: it.quantity,
        subtotal: it.subtotal,
      }))
      totalPoints.value = cart.totalPoints
      // 购物车条目不携带商品类型，实物与否以后端 ADDRESS_REQUIRED 为权威判定（需求 7.3）
      hasPhysical.value = false
    }
  } catch (err) {
    const apiErr = redemptionApi.toApiError(err)
    loadError.value = apiErr.message || t('common.failed')
  } finally {
    loading.value = false
  }
}

function reload(): void {
  void load()
}

/** 打开二次确认弹窗（需求 7.1、7.2）。若地址必填但无效则先提示 */
function openConfirm(): void {
  errorMessage.value = ''
  if (requireAddress.value) {
    const ok = addressFormRef.value?.validate() ?? false
    if (!ok) {
      errorMessage.value = t('errors.ADDRESS_REQUIRED')
      return
    }
  }
  confirmVisible.value = true
}

/** 取消：关闭弹窗，不扣积分、不扣库存（需求 7.6） */
function onCancel(): void {
  if (submitting.value) return
  confirmVisible.value = false
}

/** 确认：执行兑换（需求 7.4） */
async function onConfirm(): Promise<void> {
  submitting.value = true
  errorMessage.value = ''
  try {
    const payloadAddress = requireAddress.value ? address.value : undefined
    if (mode.value === 'instant') {
      await redemptionApi.instant(instantProductId.value, instantQuantity.value, payloadAddress)
    } else {
      await redemptionApi.checkout(payloadAddress)
      // 兑换成功后后端已从购物车移除已兑换项（需求 7.5），刷新本地镜像
      await cart.load().catch(() => {})
    }
    confirmVisible.value = false
    succeeded.value = true
    // 若历史/成功页已实现则跳转，否则展示内联成功态（向后兼容）
    if (hasHistoryRoute.value) {
      void router.push({ name: historyRouteName })
    }
  } catch (err) {
    handleRedeemError(err)
  } finally {
    submitting.value = false
  }
}

/** 将兑换错误映射为本地化提示（需求 5.4、5.5、7.3） */
function handleRedeemError(err: unknown): void {
  confirmVisible.value = false
  const apiErr = redemptionApi.toApiError(err)

  if (redemptionApi.isInsufficientPoints(apiErr)) {
    // 积分不足（需求 5.4）
    errorMessage.value = t('errors.INSUFFICIENT_POINTS')
  } else if (redemptionApi.isInsufficientStock(apiErr)) {
    // 库存不足（需求 5.5）
    errorMessage.value = t('errors.INSUFFICIENT_STOCK')
  } else if (redemptionApi.isAddressRequired(apiErr)) {
    // 含实物商品需填写地址（需求 7.3）：展示地址表单并提示
    addressRequiredByServer.value = true
    errorMessage.value = t('errors.ADDRESS_REQUIRED')
  } else {
    errorMessage.value = apiErr.message || t(redemptionApi.errorMessageKey(apiErr))
  }
}

onMounted(load)
</script>

<style scoped>
.checkout-page {
  max-width: 720px;
  margin: 0 auto;
  padding: 2rem 1rem;
}

.checkout-title {
  margin: 0 0 1.25rem;
  font-size: 1.5rem;
  color: #2c3e50;
}

.section-title {
  margin: 0 0 0.75rem;
  font-size: 1.05rem;
  color: #2c3e50;
}

.summary-section,
.address-section {
  margin-bottom: 1.5rem;
  padding: 1rem 1.25rem;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  background: #fff;
}

.summary-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.summary-item {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: center;
  gap: 1rem;
}

.item-name {
  color: #2c3e50;
  min-width: 0;
}

.item-qty {
  color: #888;
  font-size: 0.9rem;
}

.item-subtotal {
  min-width: 6rem;
  text-align: right;
  color: #2c3e50;
}

.summary-total {
  display: flex;
  align-items: baseline;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 1rem;
  padding-top: 0.85rem;
  border-top: 1px solid #eee;
}

.total-label {
  color: #555;
}

.total-value {
  font-size: 1.35rem;
  font-weight: 700;
  color: #42b983;
}

.checkout-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 0.75rem;
}

.btn-secondary {
  display: inline-block;
  padding: 0.55rem 1.1rem;
  font-size: 0.95rem;
  border-radius: 6px;
  background: #e0e0e0;
  color: #333;
  text-decoration: none;
}

.state-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding: 3rem 0;
  color: #666;
}

.state-error {
  color: #b71c1c;
}

.success-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  padding: 3rem 1rem;
  color: #555;
}

.success-text {
  margin: 0;
  font-size: 1.15rem;
  color: #2f8f65;
}

.success-actions {
  display: flex;
  gap: 1.5rem;
}

.empty-text {
  margin: 0;
}

.alert {
  margin: 0 0 1rem;
  padding: 0.6rem 0.75rem;
  border-radius: 6px;
  font-size: 0.9rem;
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
