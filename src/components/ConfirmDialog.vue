<template>
  <!-- 二次确认弹窗（需求 7.1、7.2）。取消时不产生任何副作用（需求 7.6）。 -->
  <Teleport to="body">
    <Transition name="confirm-fade">
      <div
        v-if="visible"
        class="confirm-overlay"
        role="presentation"
        @click.self="onCancel"
      >
        <div
          class="confirm-dialog"
          role="dialog"
          aria-modal="true"
          :aria-label="title"
        >
          <h2 class="confirm-title">{{ title }}</h2>
          <p class="confirm-message">{{ message }}</p>

          <div class="confirm-actions">
            <BaseButton
              variant="secondary"
              type="button"
              :disabled="loading"
              @click="onCancel"
            >
              {{ cancelText || t('common.cancel') }}
            </BaseButton>
            <BaseButton
              variant="primary"
              type="button"
              :loading="loading"
              @click="onConfirm"
            >
              {{ confirmText || t('common.confirm') }}
            </BaseButton>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import BaseButton from '@/components/BaseButton.vue'

/**
 * 通用二次确认弹窗。
 * - `confirm` 事件：用户点击确认按钮时触发（需求 7.1）。
 * - `cancel` 事件：用户点击取消 / 点击遮罩 / 关闭时触发；调用方应在此处
 *   仅关闭弹窗而不执行任何扣分扣库存等副作用（需求 7.6）。
 */
withDefaults(
  defineProps<{
    /** 是否显示弹窗 */
    visible: boolean
    /** 弹窗标题 */
    title: string
    /** 弹窗正文（如"兑换成功后不可取消，是否确认兑换？"） */
    message: string
    /** 确认按钮文案，缺省用 common.confirm */
    confirmText?: string
    /** 取消按钮文案，缺省用 common.cancel */
    cancelText?: string
    /** 确认按钮 loading（提交中禁用取消，避免重复提交） */
    loading?: boolean
  }>(),
  {
    confirmText: '',
    cancelText: '',
    loading: false,
  },
)

const emit = defineEmits<{
  (e: 'confirm'): void
  (e: 'cancel'): void
}>()

const { t } = useI18n()

function onConfirm(): void {
  emit('confirm')
}

function onCancel(): void {
  emit('cancel')
}
</script>

<style scoped>
.confirm-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.45);
}

.confirm-dialog {
  width: 100%;
  max-width: 420px;
  padding: 1.5rem;
  border-radius: 10px;
  background: #fff;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
}

.confirm-title {
  margin: 0 0 0.75rem;
  font-size: 1.2rem;
  color: #2c3e50;
}

.confirm-message {
  margin: 0 0 1.5rem;
  color: #555;
  line-height: 1.6;
}

.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
}

.confirm-fade-enter-active,
.confirm-fade-leave-active {
  transition: opacity 0.18s ease;
}

.confirm-fade-enter-from,
.confirm-fade-leave-to {
  opacity: 0;
}
</style>
