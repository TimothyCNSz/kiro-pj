<template>
  <div class="auth-page">
    <form class="auth-card" @submit.prevent="onSubmit">
      <h1 class="auth-title">登录</h1>

      <label class="field">
        <span class="field-label">邮箱</span>
        <input
          v-model.trim="email"
          type="email"
          autocomplete="username"
          placeholder="请输入公司邮箱"
          required
        />
      </label>

      <label class="field">
        <span class="field-label">密码</span>
        <input
          v-model="password"
          type="password"
          autocomplete="current-password"
          placeholder="请输入密码"
          required
        />
      </label>

      <p v-if="errorMessage" class="alert alert-error">{{ errorMessage }}</p>

      <!-- 账号未验证：提供前往验证/重发入口（需求 1.13） -->
      <p v-if="needsVerification" class="alert alert-warn">
        <RouterLink :to="{ name: 'VerifyEmail', query: { email } }">前往完成邮箱验证</RouterLink>
      </p>

      <button class="btn-primary" type="submit" :disabled="submitting">
        {{ submitting ? '登录中…' : '登录' }}
      </button>

      <p class="auth-footer">
        还没有账号？
        <RouterLink :to="{ name: 'Register' }">立即注册</RouterLink>
      </p>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { toApiError } from '@/api/auth'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const email = ref('')
const password = ref('')
const submitting = ref(false)
const errorMessage = ref('')
const needsVerification = ref(false)

async function onSubmit(): Promise<void> {
  errorMessage.value = ''
  needsVerification.value = false
  submitting.value = true
  try {
    await auth.login(email.value, password.value)
    const redirect = route.query.redirect
    const target = typeof redirect === 'string' && redirect ? redirect : '/'
    await router.push(target)
  } catch (err) {
    const apiErr = toApiError(err)
    if (apiErr.status === 403 || apiErr.code === 'EMAIL_NOT_VERIFIED') {
      // 账号处于「待验证」状态（需求 1.13）
      errorMessage.value = '邮箱尚未验证，请先完成邮箱验证'
      needsVerification.value = true
    } else if (apiErr.status === 401) {
      // 不区分邮箱或密码错误（需求 1.14）
      errorMessage.value = '邮箱或密码错误'
    } else {
      errorMessage.value = apiErr.message || '登录失败，请稍后重试'
    }
  } finally {
    submitting.value = false
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
  gap: 1rem;
  width: 100%;
  max-width: 360px;
  padding: 2rem;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  background: #fff;
}

.auth-title {
  margin: 0 0 0.5rem;
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

.btn-primary {
  padding: 0.65rem 1rem;
  font-size: 1rem;
  border: none;
  border-radius: 6px;
  background: #42b983;
  color: #fff;
  cursor: pointer;
}

.btn-primary:disabled {
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
