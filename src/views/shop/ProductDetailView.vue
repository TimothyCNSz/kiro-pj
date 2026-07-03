<template>
  <div class="detail-page">
    <p v-if="store.detailLoading" class="state-hint">{{ t('common.loading') }}</p>

    <div v-else-if="store.detailError" class="state-hint state-error">
      <span>{{ store.detailError }}</span>
      <button class="btn-secondary" type="button" @click="reload">{{ t('common.retry') }}</button>
    </div>

    <p v-else-if="!product" class="state-hint">{{ t('common.empty') }}</p>

    <article v-else class="detail">
      <RouterLink class="back-link" :to="{ name: 'Catalog' }">← {{ t('common.back') }}</RouterLink>

      <div class="detail-body">
        <!-- 图集：主图 + 附图；无图片时占位图（需求 4.5、4.6） -->
        <section class="gallery" :aria-label="t('catalog.images')">
          <div class="gallery-main">
            <img
              v-if="activeImage"
              :src="activeImage"
              :alt="product.name"
              class="gallery-main-img"
              @error="onImageError"
            />
            <div v-else class="gallery-placeholder" role="img" :aria-label="product.name">
              <span>{{ product.name.charAt(0) || '?' }}</span>
            </div>
          </div>

          <ul v-if="galleryImages.length > 1" class="gallery-thumbs">
            <li v-for="img in galleryImages" :key="img.id">
              <button
                type="button"
                class="thumb"
                :class="{ 'thumb--active': img.url === activeImage }"
                @click="activeImage = img.url"
              >
                <img :src="img.url" :alt="product.name" />
              </button>
            </li>
          </ul>
        </section>

        <!-- 商品信息 -->
        <section class="detail-info">
          <h1 class="detail-name">{{ product.name }}</h1>

          <p class="detail-type">
            <span class="tag">
              {{ product.type === 'physical' ? t('catalog.typePhysical') : t('catalog.typeVirtual') }}
            </span>
          </p>

          <p class="detail-points">
            {{ t('catalog.price') }}：
            <strong>{{ t('catalog.pricePoints', { points: product.pointsCost }) }}</strong>
          </p>

          <p class="detail-stock" :class="{ 'is-out': !product.available }">
            <span v-if="!product.available">{{ t('catalog.outOfStock') }}</span>
            <span v-else>{{ t('catalog.stock') }}：{{ product.stock }}</span>
          </p>

          <div class="detail-desc">
            <h2 class="desc-title">{{ t('catalog.description') }}</h2>
            <p class="desc-text">{{ product.description || t('common.empty') }}</p>
          </div>

          <!-- 购买动作：加入购物车 / 立即兑换（需求 6.1、7.2；零库存禁用，需求 5.2；管理员不参与兑换，需求 3.2） -->
          <div v-if="product.available && !auth.isAdmin" class="detail-actions">
            <div class="qty">
              <label class="qty-label" for="detail-qty">{{ t('cart.quantity') }}</label>
              <input
                id="detail-qty"
                v-model.number="qty"
                class="qty-input"
                type="number"
                min="1"
                :max="product.stock"
              />
            </div>
            <div class="action-buttons">
              <button class="btn-primary" type="button" :disabled="adding" @click="addToCart">
                {{ adding ? t('common.processing') : t('catalog.addToCart') }}
              </button>
              <button class="btn-redeem" type="button" @click="redeemNow">
                {{ t('catalog.redeemNow') }}
              </button>
            </div>
            <p v-if="actionMsg" class="action-msg">{{ actionMsg }}</p>
            <p v-if="actionErr" class="action-err">{{ actionErr }}</p>
          </div>
          <p v-else-if="!product.available" class="detail-soldout">{{ t('catalog.outOfStock') }}</p>
        </section>
      </div>
    </article>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useCatalogStore } from '@/stores/catalog'
import { useCartStore } from '@/stores/cart'
import { useAuthStore } from '@/stores/auth'
import { toApiError } from '@/api/cart'
import type { ProductImage } from '@/api/catalog'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const store = useCatalogStore()
const cart = useCartStore()
const auth = useAuthStore()

const product = computed(() => store.current)

// 购买动作状态
const qty = ref(1)
const adding = ref(false)
const actionMsg = ref('')
const actionErr = ref('')

/** 规整数量为 [1, stock] 内的整数 */
function normalizedQty(): number {
  const max = product.value?.stock ?? 1
  let n = Math.floor(Number(qty.value))
  if (!Number.isFinite(n) || n < 1) n = 1
  if (max > 0 && n > max) n = max
  qty.value = n
  return n
}

/** 加入购物车（需求 6.1） */
async function addToCart(): Promise<void> {
  if (!product.value) return
  actionMsg.value = ''
  actionErr.value = ''
  adding.value = true
  try {
    await cart.addItem(product.value.id, normalizedQty())
    actionMsg.value = t('cart.updated')
  } catch (err) {
    actionErr.value = toApiError(err).message || t('errors.UNKNOWN')
  } finally {
    adding.value = false
  }
}

/** 立即兑换：跳转结算页（携带 productId 与数量，需求 7.2） */
function redeemNow(): void {
  if (!product.value) return
  router.push({
    name: 'Checkout',
    query: { productId: product.value.id, quantity: String(normalizedQty()) },
  })
}

/** 图集：主图优先，其余按 sortOrder 排序（需求 4.5） */
const galleryImages = computed<ProductImage[]>(() => {
  const images = product.value?.images ?? []
  if (images.length === 0) return []
  return [...images].sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1
    return a.sortOrder - b.sortOrder
  })
})

const activeImage = ref<string | null>(null)

/** 计算初始主图 URL：优先图集主图，回退到 imageUrl 缓存 */
function resolvePrimaryUrl(): string | null {
  const p = product.value
  if (!p) return null
  if (p.isPlaceholder) return null
  if (galleryImages.value.length > 0) return galleryImages.value[0].url
  return p.imageUrl ?? null
}

watch(
  product,
  () => {
    activeImage.value = resolvePrimaryUrl()
  },
  { immediate: true },
)

function onImageError(event: Event): void {
  const img = event.target as HTMLImageElement
  img.style.display = 'none'
  activeImage.value = null
}

function reload(): void {
  store.loadDetail(String(route.params.id))
}

// 支持在详情页之间直接跳转（参数变化时重新加载）
watch(
  () => route.params.id,
  (id) => {
    if (id) store.loadDetail(String(id))
  },
  { immediate: true },
)
</script>

<style scoped>
.detail-page {
  max-width: 960px;
  margin: 0 auto;
  padding: 1.5rem;
}

.back-link {
  display: inline-block;
  margin-bottom: 1rem;
  color: #42b983;
  text-decoration: none;
  font-size: 0.9rem;
}

.back-link:hover {
  text-decoration: underline;
}

.detail-body {
  display: grid;
  grid-template-columns: minmax(280px, 1fr) 1fr;
  gap: 2rem;
}

.gallery-main {
  aspect-ratio: 1 / 1;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  overflow: hidden;
  background: #f5f5f5;
}

.gallery-main-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.gallery-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  background: linear-gradient(135deg, #eef1f4, #dfe4ea);
  color: #9aa4af;
  font-size: 4rem;
  font-weight: 600;
}

.gallery-thumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 0.75rem 0 0;
  padding: 0;
  list-style: none;
}

.thumb {
  width: 64px;
  height: 64px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 6px;
  overflow: hidden;
  cursor: pointer;
  background: #f5f5f5;
}

.thumb--active {
  border-color: #42b983;
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.detail-name {
  margin: 0 0 0.75rem;
  font-size: 1.5rem;
  color: #2c3e50;
}

.detail-type {
  margin: 0 0 0.75rem;
}

.tag {
  display: inline-block;
  padding: 0.2rem 0.6rem;
  font-size: 0.8rem;
  border-radius: 999px;
  background: #eef7f2;
  color: #2f8f65;
}

.detail-points {
  margin: 0 0 0.5rem;
  font-size: 1.1rem;
  color: #333;
}

.detail-points strong {
  color: #42b983;
}

.detail-stock {
  margin: 0 0 1.25rem;
  color: #666;
}

.detail-stock.is-out {
  color: #b71c1c;
}

.desc-title {
  margin: 0 0 0.5rem;
  font-size: 1rem;
  color: #2c3e50;
}

.desc-text {
  margin: 0;
  color: #555;
  line-height: 1.6;
  white-space: pre-wrap;
}

.detail-actions {
  margin-top: 1.5rem;
  padding-top: 1.25rem;
  border-top: 1px solid #eee;
}

.qty {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-bottom: 1rem;
}

.qty-label {
  font-size: 0.9rem;
  color: #55606a;
}

.qty-input {
  width: 88px;
  padding: 0.45rem 0.6rem;
  font-size: 0.95rem;
  border: 1px solid #ccc;
  border-radius: 6px;
}

.action-buttons {
  display: flex;
  gap: 0.75rem;
}

.btn-primary,
.btn-redeem {
  padding: 0.6rem 1.4rem;
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

.btn-redeem {
  background: #e67e22;
  color: #fff;
}

.action-msg {
  margin: 0.75rem 0 0;
  color: #1b5e20;
  font-size: 0.9rem;
}

.action-err {
  margin: 0.75rem 0 0;
  color: #b71c1c;
  font-size: 0.9rem;
}

.detail-soldout {
  margin-top: 1.5rem;
  padding-top: 1.25rem;
  border-top: 1px solid #eee;
  color: #b71c1c;
  font-weight: 600;
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

.btn-secondary {
  padding: 0.5rem 1rem;
  font-size: 0.95rem;
  border: none;
  border-radius: 6px;
  background: #e0e0e0;
  color: #333;
  cursor: pointer;
}

@media (max-width: 640px) {
  .detail-body {
    grid-template-columns: 1fr;
  }
}
</style>
