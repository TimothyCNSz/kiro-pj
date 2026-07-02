<template>
  <div class="auth-page">
    <!-- 注册成功后的结果态（需求 1.4） -->
    <div v-if="registered" class="auth-card">
      <h1 class="auth-title">注册成功</h1>

      <p v-if="emailSendFailed" class="alert alert-warn">
        注册成功但验证邮件发送失败，请稍后重发验证邮件。
      </p>
      <p v-else class="alert alert-success">
        验证邮件已发送至 {{ email }}，请完成邮箱验证后再登录。
      </p>

      <button
        class="btn-secondary"
        type="button"
        :disabled="resending"
        @click="onResend"
      >
        {{ resending ? '重发中…' : '重发验证邮件' }}
      </button>
      <p v-if="resendMessage" class="alert alert-success">{{ resendMessage }}</p>
      <p v-if="resendError" class="alert alert-error">{{ resendError }}</p>

      <p class="auth-footer">
        已完成验证？
        <RouterLink :to="{ name: 'Login' }">前往登录</RouterLink>
      </p>
    </div>

    <!-- 注册表单 -->
    <form v-else class="auth-card" @submit.prevent="onSubmit">
      <h1 class="auth-title">注册</h1>
      <p class="hint">仅支持使用公司邮箱注册。</p>

      <label class="field">
        <span class="field-label">邮箱</span>
        <input
          v-model.trim="email"
          type="email"
          autocomplete="username"
          placeholder="name@company.com"
        />
        <span v-if="fieldErrors.email" class="field-error">{{ fieldErrors.email }}</span>
      </label>

      <label class="field">
        <span class="field-label">密码</span>
        <input
          v-model="password"
          type="password"
          autocomplete="new-password"
          placeholder="至少 8 位，含字母与数字"
        />
        <span class="hint">密码需至少 8 位，且同时包含字母与数字。</span>
        <span v-if="fieldErrors.password" class="field-error">{{ fieldErrors.password }}</span>
      </label>

      <ul v-if="itemizedErrors.length" class="error-list">
        <li v-for="(msg, i) in itemizedErrors" :key="i">{{ msg }}</li>
      </ul>

      <p v-if="errorMessage" class="alert alert-error">{{ errorMessage }}</p>

      <button class="btn-primary" type="submit" :disabled="submitting">
        {{ submitting ? '提交中…' : '注册' }}
      </button>

      <p class="auth-footer">
        已有账号？
        <RouterLink :to="{ name: 'Login' }">前往登录</RouterLink>
      </p>
    </form>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { toApiError } from '@/api/auth'

const auth = useAuthStore()

const email = ref('')
const password = ref('')
const submitting = ref(false)
const errorMessage = ref('')
const fieldErrors = reactive<{ email?: string; password?: string }>({})
const itemizedErrors = ref<string[]>([])

const registered = ref(false)
const emailSendFailed = ref(false)
const resending = ref(false)
const resendMessage = ref('')
const resendError = ref('')

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** 客户端逐项校验（需求 1.1、1.6）；返回错误项列表 */
function validate(): string[] {
  fieldErrors.email = undefined
  fieldErrors.password = undefined
  const errors: string[] = []

  if (!email.value) {
    fieldErrors.email = '请输入邮箱'
    errors.push('请输入邮箱')
  } else if (!EMAIL_RE.test(email.value)) {
    fieldErrors.email = '邮箱格式无效'
    errors.push('邮箱格式无效')
  }

  const pwd = password.value
  if (pwd.length < 8) {
    const msg = '密码长度至少 8 位'
    fieldErrors.password = msg
    errors.push(msg)
  }
  if (!/[a-zA-Z]/.test(pwd) || !/\d/.test(pwd)) {
    const msg = '密码需同时包含字母与数字'
    fieldErrors.password = fieldErrors.password ? `${fieldErrors.password}；${msg}` : msg
    errors.push(msg)
  }

  return errors
}

async function onSubmit(): Promise<void> {
  errorMessage.value = ''
  itemizedErrors.value = validate()
  if (itemizedErrors.value.length > 0) {
    return
  }

  submitting.value = true
  try {
    const result = await auth.register(email.value, password.value)
    emailSendFailed.value = result.emailSendFailed === true
    registered.value = true
  } catch (err) {
    const apiErr = toApiError(err)
    if (apiErr.status === 409 || apiErr.code === 'EMAIL_TAKEN') {
      fieldErrors.email = '该邮箱已被注册'
      errorMessage.value = '该邮箱已被注册'
    } else if (apiErr.status === 422 || apiErr.code === 'VALIDATION') {
      // 后端逐项校验错误（含公司邮箱域名限制，需求 1.6、1.7）
      if (apiErr.fieldErrors) {
        fieldErrors.email = apiErr.fieldErrors.email ?? fieldErrors.email
        fieldErrors.password = apiErr.fieldErrors.password ?? fieldErrors.password
        itemizedErrors.value = Object.values(apiErr.fieldErrors)
      }
      errorMessage.value = apiErr.message || '注册信息校验失败，请检查后重试'
    } else {
      errorMessage.value = apiErr.message || '注册失败，请稍后重试'
    }
  } finally {
    submitting.value = false
  }
}

async function onResend(): Promise<void> {
  resendMessage.value = ''
  resendError.value = ''
  resending.value = true
  try {
    await auth.resendVerification(email.value)
    resendMessage.value = '验证邮件已重发，请查收。'
    emailSendFailed.value = false
  } catch (err) {
    const apiErr = toApiError(err)
    resendError.value = apiErr.message || '重发失败，请稍后重试'
  } finally {
    resending.value = false
  }
}
</script>

<style scoped>
.auth-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 2rem;
}

.auth-card {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  width: 100%;
  max-width: 380px;
  padding: 2rem;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  background: #fff;
}

.auth-title {
  margin: 0;
  font-size: 1.5rem;
  color: #2c3e50;
  text-align: center;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.field-label {
  font-size: 0.875rem;
  color: #555;
}

input {
  padding: 0.6rem 0.75rem;
  font-size: 1rem;
  border: 1px solid #ccc;
  border-radius: 6px;
}

input:focus {
  outline: none;
  border-color: #42b983;
}

.hint {
  margin: 0;
  font-size: 0.8rem;
  color: #888;
}

.field-error {
  font-size: 0.8rem;
  color: #b71c1c;
}

.error-list {
  margin: 0;
  padding-left: 1.1rem;
  color: #b71c1c;
  font-size: 0.85rem;
}

.btn-primary {
  padding: 0.65rem 1rem;
  font-size: 1rem;
  border: none;
  border-radius: 6px;
  background: #42b983;
  color: #fff;
  cursor: pointer;
}

.btn-secondary {
  padding: 0.6rem 1rem;
  font-size: 0.95rem;
  border: 1px solid #42b983;
  border-radius: 6px;
  background: #fff;
  color: #2c8f66;
  cursor: pointer;
}

.btn-primary:disabled,
.btn-secondary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.alert {
  margin: 0;
  padding: 0.6rem 0.75rem;
  border-radius: 6px;
  font-size: 0.875rem;
}

.alert-error {
  background: #fdecea;
  color: #b71c1c;
}

.alert-warn {
  background: #fff4e5;
  color: #8a5300;
}

.alert-success {
  background: #e8f5e9;
  color: #1b5e20;
}

.auth-footer {
  margin: 0;
  font-size: 0.875rem;
  color: #666;
  text-align: center;
}

a {
  color: #42b983;
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}
</style>
