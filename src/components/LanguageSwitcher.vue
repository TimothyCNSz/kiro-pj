<template>
  <div class="language-switcher">
    <label class="language-switcher__label" for="language-switcher-select">
      {{ t('language.label') }}
    </label>
    <select
      id="language-switcher-select"
      class="language-switcher__select"
      :value="locale"
      :aria-label="t('language.switchTo')"
      @change="onChange"
    >
      <option v-for="option in options" :key="option" :value="option">
        {{ t(`language.${option}`) }}
      </option>
    </select>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { SUPPORTED_LOCALES, persistLocale, isSupportedLocale, type AppLocale } from '@/i18n'

const { t, locale } = useI18n()

const options = SUPPORTED_LOCALES

function onChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  if (isSupportedLocale(value)) {
    locale.value = value as AppLocale
    persistLocale(value)
  }
}
</script>

<style scoped>
.language-switcher {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}

.language-switcher__label {
  font-size: 0.875rem;
  color: #555;
}

.language-switcher__select {
  padding: 0.25rem 0.5rem;
  border: 1px solid #ccc;
  border-radius: 4px;
  background: #fff;
  font-size: 0.875rem;
  cursor: pointer;
}
</style>
