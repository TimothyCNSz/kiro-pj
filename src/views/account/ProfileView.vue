<template>
  <div class="profile-page">
    <section class="profile-card">
      <h1 class="profile-title">{{ t('account.profile') }}</h1>

      <div class="avatar-block">
        <!-- 头像展示：avatarUrl 为空时回退默认头像（需求 23.2） -->
        <img class="avatar" :src="displayAvatar" :alt="t('account.avatar')" />

        <div class="avatar-actions">
          <button
            class="btn-primary"
            type="button"
            :disabled="uploading"
            @click="onPick"
          >
            {{ uploading ? t('common.processing') : hasAvatar ? t('account.changeAvatar') : t('account.uploadAvatar') }}
          </button>
          <p class="hint">{{ t('common.optional') }} · JPG / PNG / WebP · ≤ 5MB</p>
        </div>

        <!-- 隐藏的文件选择器 -->
        <input
          ref="fileInput"
          class="file-input"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          @change="onFileChange"
        />
      </div>

      <p v-if="errorMessage" class="alert alert-error">{{ errorMessage }}</p>
      <p v-if="successMessage" class="alert alert-success">{{ successMessage }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { toApiError } from '@/api/auth'
import {
  ALLOWED_AVATAR_TYPES,
  MAX_AVATAR_SIZE,
  presignAvatar,
  putToPresignedUrl,
  setAvatar,
  type AllowedAvatarType,
} from '@/api/profile'
import defaultAvatar from '@/assets/default-avatar.svg'

const { t } = useI18n()
const auth = useAuthStore()

const fileInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const errorMessage = ref('')
const successMessage = ref('')

// 当前头像 URL（内存态）：空表示未设置 → 回退默认头像（需求 23.2）
const currentAvatarUrl = ref<string>('')

const hasAvatar = computed(() => currentAvatarUrl.value.trim().length > 0)
// 解析展示头像：非空用之，为空回退默认头像（需求 23.2、23.4）
const displayAvatar = computed(() => (hasAvatar.value ? currentAvatarUrl.value : defaultAvatar))

/** 当前登录员工 ID（用作 presign 的 targetId，后端限本人） */
const userId = computed(() => auth.user?.userId ?? null)

onMounted(async () => {
  // 刷新后 user 可能为空，尝试水合以获取 userId 与既有头像
  if (!auth.user) {
    try {
      await auth.fetchMe()
    } catch {
      // 会话失效由全局拦截/路由守卫处理，这里静默
    }
  }
  // 后端 /auth/me 可能返回既有 avatarUrl（类型上为可选），存在则展示
  const existing = (auth.user as { avatarUrl?: string | null } | null)?.avatarUrl
  if (existing && existing.trim()) {
    currentAvatarUrl.value = existing
  }
})

function onPick(): void {
  errorMessage.value = ''
  successMessage.value = ''
  fileInput.value?.click()
}

/** 前端即时校验：格式（22.4）与大小（22.5）。校验通过返回 true。 */
function validate(file: File): boolean {
  if (!(ALLOWED_AVATAR_TYPES as readonly string[]).includes(file.type)) {
    errorMessage.value = t('errors.UNSUPPORTED_IMAGE_TYPE')
    return false
  }
  if (file.size > MAX_AVATAR_SIZE) {
    errorMessage.value = t('errors.IMAGE_TOO_LARGE')
    return false
  }
  return true
}

async function onFileChange(event: Event): Promise<void> {
  errorMessage.value = ''
  successMessage.value = ''

  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // 允许再次选择同一文件：处理后清空 input 值
  input.value = ''
  if (!file) return

  if (!validate(file)) return

  const uid = userId.value
  if (!uid) {
    errorMessage.value = t('errors.UNAUTHENTICATED')
    return
  }

  uploading.value = true
  try {
    // 1. 签发预签名 URL（需求 22.6）
    const { uploadUrl, publicUrl, objectKey } = await presignAvatar(
      file.type as AllowedAvatarType,
      file.size,
      uid,
    )
    // 2. 直传 S3，字节流不经后端（需求 22.7）
    await putToPresignedUrl(uploadUrl, file)
    // 3. 关联到当前员工，获取权威 avatarUrl（需求 23.3）
    const { avatarUrl } = await setAvatar(objectKey)

    // 4. 即时替换展示的头像（需求 23.4）
    currentAvatarUrl.value = avatarUrl || publicUrl
    successMessage.value = t('common.success')
  } catch (err) {
    errorMessage.value = resolveError(err)
  } finally {
    uploading.value = false
  }
}

/** 将上传各阶段的错误映射为本地化提示。 */
function resolveError(err: unknown): string {
  const apiErr = toApiError(err)
  // S3 直传过期/被拒（预签名 URL 过期，需求 22.8）
  if (apiErr.status === 403 || apiErr.status === 410) {
    return t('errors.UPLOAD_URL_EXPIRED')
  }
  if (typeof apiErr.code === 'string') {
    const key = `errors.${apiErr.code}`
    const translated = t(key)
    if (translated !== key) return translated
  }
  if (apiErr.status === undefined) {
    return t('errors.NETWORK')
  }
  return apiErr.message || t('errors.UNKNOWN')
}
</script>

<style scoped>
.profile-page {
  display: flex;
  justify-content: center;
  padding: 2rem;
}

.profile-card {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  width: 100%;
  max-width: 420px;
  padding: 2rem;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  background: #fff;
}

.profile-title {
  margin: 0;
  font-size: 1.5rem;
  color: #2c3e50;
  text-align: center;
}

.avatar-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
}

.avatar {
  width: 120px;
  height: 120px;
  border-radius: 50%;
  object-fit: cover;
  border: 1px solid #e0e0e0;
  background: #f5f6f8;
}

.avatar-actions {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}

.hint {
  margin: 0;
  font-size: 0.8rem;
  color: #888;
}

.file-input {
  display: none;
}

.btn-primary {
  padding: 0.55rem 1.25rem;
  font-size: 0.95rem;
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
  text-align: center;
}

.alert-error {
  background: #fdecea;
  color: #b71c1c;
}

.alert-success {
  background: #e8f5e9;
  color: #1b5e20;
}
</style>
