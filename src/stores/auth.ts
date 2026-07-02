import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import * as authApi from '@/api/auth'
import type { LoginResult, MeResult, RegisterResult, Role } from '@/api/auth'

const TOKEN_KEY = 'token'

/**
 * 认证会话 Store。
 * - `token` 持久化到 localStorage（键 `token`），与 `http.ts` 的请求拦截器约定一致。
 * - `role` / `user` 仅存于内存；页面刷新后可通过 `fetchMe()` 重新水合。
 */
export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(localStorage.getItem(TOKEN_KEY))
  const role = ref<Role | null>(null)
  const user = ref<MeResult | null>(null)

  const isAuthenticated = computed(() => !!token.value)
  const isAdmin = computed(() => role.value === 'admin')

  function setToken(value: string | null): void {
    token.value = value
    if (value) {
      localStorage.setItem(TOKEN_KEY, value)
    } else {
      localStorage.removeItem(TOKEN_KEY)
    }
  }

  /** 清理本地会话状态（token/role/user） */
  function clearSession(): void {
    setToken(null)
    role.value = null
    user.value = null
  }

  /** 登录：成功后写入 token 与 role */
  async function login(email: string, password: string): Promise<LoginResult> {
    const result = await authApi.login(email, password)
    setToken(result.token)
    role.value = result.role
    return result
  }

  /** 登出：调用后端终止会话并清理本地状态（后端失败也清理本地） */
  async function logout(): Promise<void> {
    try {
      await authApi.logout()
    } finally {
      clearSession()
    }
  }

  /** 拉取当前用户信息并水合 role/user；失败时清理本地会话 */
  async function fetchMe(): Promise<MeResult | null> {
    if (!token.value) return null
    try {
      const me = await authApi.fetchMe()
      user.value = me
      role.value = me.role
      return me
    } catch (err) {
      clearSession()
      throw err
    }
  }

  /** 注册：创建「待验证」账号并触发验证邮件 */
  async function register(email: string, password: string): Promise<RegisterResult> {
    return authApi.register(email, password)
  }

  /** 通过验证链接/验证码完成邮箱验证 */
  async function verifyEmail(verificationToken: string) {
    return authApi.verifyEmail(verificationToken)
  }

  /** 对「待验证」账号重发验证邮件 */
  async function resendVerification(email: string): Promise<void> {
    return authApi.resendVerification(email)
  }

  return {
    // state
    token,
    role,
    user,
    // getters
    isAuthenticated,
    isAdmin,
    // actions
    setToken,
    clearSession,
    login,
    logout,
    fetchMe,
    register,
    verifyEmail,
    resendVerification,
  }
})
