<template>
  <!-- 配送地址表单：兑换含实物商品时必填（需求 7.3、8.1） -->
  <form class="address-form" novalidate @submit.prevent>
    <p v-if="required" class="address-hint">{{ t('checkout.addressRequiredHint') }}</p>

    <div class="field">
      <label class="field-label" :for="ids.recipient">
        {{ t('checkout.recipient') }}
        <span v-if="required" class="req" aria-hidden="true">*</span>
      </label>
      <input
        :id="ids.recipient"
        v-model.trim="local.recipient"
        class="field-input"
        type="text"
        autocomplete="name"
        :placeholder="t('checkout.recipientPlaceholder')"
        @blur="touch('recipient')"
        @input="emitUpdate"
      />
      <p v-if="showError('recipient')" class="field-error">
        {{ t('checkout.fieldRequired', { field: t('checkout.recipient') }) }}
      </p>
    </div>

    <div class="field">
      <label class="field-label" :for="ids.phone">
        {{ t('checkout.phone') }}
        <span v-if="required" class="req" aria-hidden="true">*</span>
      </label>
      <input
        :id="ids.phone"
        v-model.trim="local.phone"
        class="field-input"
        type="tel"
        autocomplete="tel"
        :placeholder="t('checkout.phonePlaceholder')"
        @blur="touch('phone')"
        @input="emitUpdate"
      />
      <p v-if="showError('phone')" class="field-error">
        {{
          local.phone && !isPhoneValid
            ? t('checkout.phoneInvalid')
            : t('checkout.fieldRequired', { field: t('checkout.phone') })
        }}
      </p>
    </div>

    <div class="field">
      <label class="field-label" :for="ids.detail">
        {{ t('checkout.addressDetail') }}
        <span v-if="required" class="req" aria-hidden="true">*</span>
      </label>
      <textarea
        :id="ids.detail"
        v-model.trim="local.detail"
        class="field-input field-textarea"
        rows="3"
        autocomplete="street-address"
        :placeholder="t('checkout.addressDetailPlaceholder')"
        @blur="touch('detail')"
        @input="emitUpdate"
      ></textarea>
      <p v-if="showError('detail')" class="field-error">
        {{ t('checkout.fieldRequired', { field: t('checkout.addressDetail') }) }}
      </p>
    </div>
  </form>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Address } from '@/api/redemption'

/**
 * 配送地址表单组件。
 * - 通过 `v-model` 双向绑定 {@link Address}。
 * - `required` 为真时（兑换含实物商品）三个字段均必填（需求 7.3）。
 * - 通过 `defineExpose` 暴露 `validate()`，供父组件在确认前做校验；
 *   校验失败会标记所有字段为已触碰并显示逐项错误。
 */
const props = withDefaults(
  defineProps<{
    modelValue: Address
    /** 是否必填（含实物商品时为真） */
    required?: boolean
  }>(),
  {
    required: false,
  },
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: Address): void
}>()

const { t } = useI18n()

type FieldName = 'recipient' | 'phone' | 'detail'

// 本地可编辑副本，避免直接修改 prop
const local = reactive<Address>({
  recipient: props.modelValue.recipient ?? '',
  phone: props.modelValue.phone ?? '',
  detail: props.modelValue.detail ?? '',
})

// 唯一 id 前缀，避免同页多个表单 label/for 冲突
const uid = Math.random().toString(36).slice(2, 8)
const ids = {
  recipient: `addr-recipient-${uid}`,
  phone: `addr-phone-${uid}`,
  detail: `addr-detail-${uid}`,
}

const touched = ref<Record<FieldName, boolean>>({
  recipient: false,
  phone: false,
  detail: false,
})

// 基础电话号码校验（演示级）：允许数字、空格、+、-，长度 6-20
const isPhoneValid = computed(() => /^[+\-\d\s]{6,20}$/.test(local.phone.trim()))

/** 单字段是否有效 */
function isFieldValid(field: FieldName): boolean {
  if (!props.required) return true
  if (field === 'phone') return local.phone.trim().length > 0 && isPhoneValid.value
  return local[field].trim().length > 0
}

/** 是否展示某字段的错误（已触碰且无效） */
function showError(field: FieldName): boolean {
  return touched.value[field] && !isFieldValid(field)
}

function touch(field: FieldName): void {
  touched.value = { ...touched.value, [field]: true }
}

function emitUpdate(): void {
  emit('update:modelValue', {
    recipient: local.recipient.trim(),
    phone: local.phone.trim(),
    detail: local.detail.trim(),
  })
}

// 外部修改 modelValue 时同步到本地副本
watch(
  () => props.modelValue,
  (val) => {
    if (
      val.recipient !== local.recipient ||
      val.phone !== local.phone ||
      val.detail !== local.detail
    ) {
      local.recipient = val.recipient ?? ''
      local.phone = val.phone ?? ''
      local.detail = val.detail ?? ''
    }
  },
)

/** 是否整体有效 */
const isValid = computed(
  () => isFieldValid('recipient') && isFieldValid('phone') && isFieldValid('detail'),
)

/**
 * 校验整个表单，标记所有字段为已触碰以显示错误。
 * @returns 是否通过校验
 */
function validate(): boolean {
  touched.value = { recipient: true, phone: true, detail: true }
  return isValid.value
}

defineExpose({ validate, isValid })
</script>

<style scoped>
.address-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.address-hint {
  margin: 0;
  padding: 0.5rem 0.75rem;
  border-radius: 6px;
  background: #fff8e1;
  color: #8a6d3b;
  font-size: 0.85rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.field-label {
  font-size: 0.9rem;
  color: #2c3e50;
}

.req {
  color: #b71c1c;
  margin-left: 0.15rem;
}

.field-input {
  width: 100%;
  padding: 0.55rem 0.7rem;
  border: 1px solid #ccc;
  border-radius: 6px;
  font-size: 0.95rem;
  box-sizing: border-box;
}

.field-input:focus {
  outline: none;
  border-color: #42b983;
}

.field-textarea {
  resize: vertical;
  font-family: inherit;
}

.field-error {
  margin: 0;
  color: #b71c1c;
  font-size: 0.8rem;
}
</style>
