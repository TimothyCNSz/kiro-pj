<template>
  <div class="auth-page">
    <div class="auth-card">
      <h1 class="auth-title">邮箱验证</h1>

      <!-- 验证中 -->
      <p v-if="state === 'verifying'" class="alert alert-info">正在验证，请稍候…</p>

      <!-- 验证成功（需求 1.9） -->
      <template v-else-if="state === 'success'">
        <p class="alert alert-success">邮箱验证成功，现在可以登录了。</p>
        <RouterLink class="btn-primary link-btn" :to="{ name: 'Login', query: { email } }">
          前往登录
        </RouterLink>
      </template>

      <!-- 令牌已过期（需求 1.10）或无效（需求 1.9），均显示重发入口（需求 1.11） -->
      <template v-else>
        <p v-if="state === 'expired'" class="alert alert-warn">
          验证链接/验证码已过期，请重新发送验证邮件。
        </p>
        <p v-else-if="state === 'invalid'" class="alert alert-error">
          验证失败：验证链接/验证码无效，请重新发送验证邮件。
        </p>
        <p v-else-if="state === 'error' && errorMessage" class="alert alert-error">
          {{ errorMessage }}
        </p>

        <!-- 手动输入验证码/令牌 -->
        <label class="field">
          <span class="field-label">验证码 / 验证令牌</span>
          <input
            v-model.trim="manualToken"
            type="text"
            placeholder="粘贴验证链接中的令牌或输入验证码"
          />
        </label>
        <button
          class="btn-primary"
          type="button"
          :disabled="verifyingManual || !manualToken"
          @click="verify(manualToken)"
        >
          {{ verifyingManual ? '验证中…' : '提交验证' }}
        </button>

        <hr class="divider" />

        <!-- 重发验证邮件（需求 1.11） -->
        <label class="field">
          <span class="field-label">公司邮箱</span>
          <input
            v-model.trim="email"
            type="email"
            autocomplete="username"
            placeholder="请输入注册邮箱"
          />
        </label>
        <button
          class="btn-secondary"
          type="button"
          :disabled="resending || !email"
          @click="onResend"
        >
          {{ resending ? '重发中…' : '重发验证邮件' }}
        </button>
        <p v-if="resendMessage" class="alert alert-success">{{ resendMessage }}</p>
        <p v-if="resendError" class="alert alert-error">{{ resendError }}</p>
      </template>

      <p class="auth-footer">
        <RouterLink :to="{ name: 'Login' }">返回登录</RouterLink>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { toApiError } from '@/api/auth'

type VerifyState = 'idle' | 'verifying' | 'success' | 'expired' | 'invalid' | 'error'

const route = useRoute()
const auth = useAuthStore()

const state = ref<VerifyState>('idle')
const errorMessage = ref('')
const verifyingManual = ref(false)

const manualToken = ref('')
const email = ref(typeof route.query.email === 'string' ? route.query.email : '')

const resending = ref(false)
const resendMessage = ref('')
const resendError = ref('')

async function verify(token: string): Promise<void> {
  if (!token) return
  errorMessage.value = ''
  const usingManual = token === manualToken.value
  if (usingManual) {
    verifyingManual.value = true
  } else {
    state.value = 'verifying'
  }
  try {
    await auth.verifyEmail(token)
    state.value = 'success'
  } catch (err) {
    const apiErr = toApiError(err)
    if (apiErr.status === 410 || apiErr.code === 'VERIFICATION_EXPIRED') {
      state.value = 'expired'
    } else if (apiErr.status === 400 || apiErr.code === 'VERIFICATION_INVALID') {
      state.value = 'invalid'
    } else {
      state.value = 'error'
      errorMessage.value = apiErr.message || '验证失败，请稍后重试'
    }
  } finally {
    verifyingManual.value = false
  }
}

async function onResend(): Promise<void> {
  resendMessage.value = ''
  resendError.value = ''
  resending.value = true
  try {
    await auth.resendVerification(email.value)
    resendMessage.value = '验证邮件已重发，请查收。'
  } catch (err) {
    const apiErr = toApiError(err)
    resendError.value = apiErr.message || '重发失败，请稍后重试'
  } finally {
    resending.value = false
  }
}

onMounted(() => {
  // 处理邮件中的验证链接 /verify-email?token=...
  const token = route.query.token
  if (typeof token === 'string' && token) {
    manualToken.value = token
    void verify(token)
  }
})
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
  max-width: 400px;
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

.divider {
  width: 100%;
  border: none;
  border-top: 1px solid #eee;
  margin: 0.25rem 0;
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

.link-btn {
  display: inline-block;
  text-align: center;
  text-decoration: none;
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

.alert-info {
  background: #e7f2fb;
  color: #0b4f79;
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
