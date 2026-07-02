<template>
  <div class="catalog-page">
    <header class="catalog-header">
      <h1 class="catalog-title">{{ t('catalog.title') }}</h1>

      <!-- 搜索框（需求 4.3） -->
      <form class="search-bar" @submit.prevent="onSearch">
        <input
          v-model.trim="keywordInput"
          type="search"
          class="search-input"
          :placeholder="t('catalog.searchPlaceholder')"
          :aria-label="t('catalog.searchPlaceholder')"
        />
        <button class="btn-primary" type="submit">{{ t('common.search') }}</button>
        <button
          v-if="store.isSearching"
          class="btn-secondary"
          type="button"
          @click="onClear"
        >
          {{ t('common.reset') }}
        </button>
      </form>
    </header>

    <!-- 加载中 -->
    <p v-if="store.listLoading" class="state-hint">{{ t('common.loading') }}</p>

    <!-- 加载失败 -->
    <div v-else-if="store.listError" class="state-hint state-error">
      <span>{{ store.listError }}</span>
      <button class="btn-secondary" type="button" @click="store.load()">
        {{ t('common.retry') }}
      </button>
    </div>

    <!-- 搜索无结果（需求 4.4） -->
    <p v-else-if="store.isSearchEmpty" class="state-hint">{{ t('catalog.noSearchResults') }}</p>

    <!-- 无商品 -->
    <p v-else-if="store.isEmpty" class="state-hint">{{ t('catalog.empty') }}</p>

    <!-- 商品网格（需求 4.1） -->
    <ul v-else class="product-grid">
      <li v-for="product in store.items" :key="product.id" class="product-card">
        <RouterLink
          class="product-link"
          :to="{ name: 'ProductDetail', params: { id: product.id } }"
        >
          <div class="product-thumb">
            <img
              v-if="product.imageUrl && !product.isPlaceholder"
              :src="product.imageUrl"
              :alt="product.name"
              class="product-image"
              @error="onImageError"
            />
            <!-- 占位图（需求 4.6） -->
            <div v-else class="product-placeholder" role="img" :aria-label="product.name">
              <span>{{ product.name.charAt(0) || '?' }}</span>
            </div>
          </div>

          <div class="product-info">
            <h2 class="product-name" :title="product.name">{{ product.name }}</h2>
            <p class="product-points">{{ t('catalog.pricePoints', { points: product.pointsCost }) }}</p>
            <p class="product-stock" :class="{ 'is-out': !product.available }">
              <span v-if="!product.available">{{ t('catalog.outOfStock') }}</span>
              <span v-else>{{ t('catalog.stock') }}: {{ product.stock }}</span>
            </p>
          </div>
        </RouterLink>
      </li>
    </ul>

    <!-- 分页 -->
    <nav v-if="!store.listLoading && !store.isEmpty && store.totalPages > 1" class="pagination">
      <button
        class="btn-secondary"
        type="button"
        :disabled="store.page <= 1"
        @click="store.goToPage(store.page - 1)"
      >
        {{ t('common.previous') }}
      </button>
      <span class="page-indicator">{{ store.page }} / {{ store.totalPages }}</span>
      <button
        class="btn-secondary"
        type="button"
        :disabled="store.page >= store.totalPages"
        @click="store.goToPage(store.page + 1)"
      >
        {{ t('common.next') }}
      </button>
    </nav>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useCatalogStore } from '@/stores/catalog'

const { t } = useI18n()
const store = useCatalogStore()

const keywordInput = ref(store.keyword)

async function onSearch(): Promise<void> {
  await store.search(keywordInput.value)
}

async function onClear(): Promise<void> {
  keywordInput.value = ''
  await store.clearSearch()
}

/** 图片加载失败时降级为占位图（需求 4.6） */
function onImageError(event: Event): void {
  const img = event.target as HTMLImageElement
  img.style.display = 'none'
}

onMounted(() => {
  store.load(1)
})
</script>

<style scoped>
.catalog-page {
  max-width: 1080px;
  margin: 0 auto;
  padding: 1.5rem;
}

.catalog-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.5rem;
}

.catalog-title {
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

.product-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1rem;
  list-style: none;
  margin: 0;
  padding: 0;
}

.product-card {
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  overflow: hidden;
  background: #fff;
  transition: box-shadow 0.2s;
}

.product-card:hover {
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
}

.product-link {
  display: block;
  color: inherit;
  text-decoration: none;
}

.product-thumb {
  aspect-ratio: 4 / 3;
  background: #f5f5f5;
}

.product-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.product-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  background: linear-gradient(135deg, #eef1f4, #dfe4ea);
  color: #9aa4af;
  font-size: 2.5rem;
  font-weight: 600;
}

.product-info {
  padding: 0.75rem;
}

.product-name {
  margin: 0 0 0.4rem;
  font-size: 1rem;
  color: #2c3e50;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.product-points {
  margin: 0 0 0.25rem;
  font-weight: 600;
  color: #42b983;
}

.product-stock {
  margin: 0;
  font-size: 0.85rem;
  color: #666;
}

.product-stock.is-out {
  color: #b71c1c;
}

.state-hint {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 2rem 0;
  color: #666;
  text-align: center;
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
