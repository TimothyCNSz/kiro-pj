<template>
  <div class="points-page">
    <section class="points-card">
      <h1 class="points-title">{{ t('account.pointsBalance') }}</h1>

      <!-- 加载中 -->
      <p v-if="loading" class="state-hint">{{ t('common.loading') }}</p>

      <!-- 加载失败 -->
      <div v-else-if="errorMessage" class="state-hint state-error">
        <span>{{ errorMessage }}</span>
        <button class="btn-secondary" type="button" @click="load">{{ t('common.retry') }}</button>
      </div>

      <!-- 当前积分余额（需求 10.1） -->
      <p v-else class="points-value">{{ balance }}</p>

      <p v-if="!loading && !errorMessage" class="points-caption">
        {{ t('checkout.pointsBalance') }}
      </p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { getBalance } from '@/api/orders'
import { toApiError } from '@/api/cart'

const { t } = useI18n()

const balance = ref(0)
const loading = ref(false)
const errorMessage = ref('')

async function load(): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  try {
    // 每次进入页面拉取权威余额，反映最新变化（需求 10.2）
    balance.value = await getBalance()
  } catch (err) {
    const apiErr = toApiError(err)
    errorMessage.value = apiErr.message || t('errors.UNKNOWN')
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.points-page {
  display: flex;
  justify-content: center;
  padding: 2rem;
}

.points-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  width: 100%;
  max-width: 420px;
  padding: 2.5rem 2rem;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  background: #fff;
  text-align: center;
}

.points-title {
  margin: 0;
  font-size: 1.25rem;
  color: #2c3e50;
}

.points-value {
  margin: 0;
  font-size: 3rem;
  font-weight: 700;
  color: #42b983;
  line-height: 1;
}

.points-caption {
  margin: 0;
  font-size: 0.85rem;
  color: #888;
}

.state-hint {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 1.5rem 0;
  color: #666;
  justify-content: center;
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
</style>
