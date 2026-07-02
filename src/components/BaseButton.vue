<template>
  <button
    :class="['base-btn', `base-btn--${variant}`, { 'base-btn--loading': loading }]"
    :disabled="disabled || loading"
    v-bind="$attrs"
  >
    <span v-if="loading" class="base-btn__spinner" aria-hidden="true"></span>
    <slot />
  </button>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'danger'
    loading?: boolean
    disabled?: boolean
  }>(),
  {
    variant: 'primary',
    loading: false,
    disabled: false,
  },
)
</script>

<style scoped>
.base-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1.25rem;
  font-size: 1rem;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.2s, opacity 0.2s;
}

.base-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.base-btn--primary {
  background: #42b983;
  color: white;
}

.base-btn--primary:hover:not(:disabled) {
  background: #33a06f;
}

.base-btn--secondary {
  background: #e0e0e0;
  color: #333;
}

.base-btn--secondary:hover:not(:disabled) {
  background: #c8c8c8;
}

.base-btn--danger {
  background: #e74c3c;
  color: white;
}

.base-btn--danger:hover:not(:disabled) {
  background: #c0392b;
}

.base-btn__spinner {
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
