/**
 * vue-i18n 配置（需求 17）。
 *
 * - 默认语言为中文（`zh`），回退语言同样为 `zh`，确保任何缺失键都回退到中文。
 * - 用户选择的语言持久化到 localStorage，刷新后保持。
 * - 采用 Composition API 模式（`legacy: false`），配合 `useI18n()` 使用。
 */
import { createI18n } from 'vue-i18n'
import zh from './locales/zh'
import ja from './locales/ja'

export const SUPPORTED_LOCALES = ['zh', 'ja'] as const
export type AppLocale = (typeof SUPPORTED_LOCALES)[number]

export const DEFAULT_LOCALE: AppLocale = 'zh'
const STORAGE_KEY = 'app.locale'

/** 判断给定字符串是否为受支持的语言。 */
export function isSupportedLocale(value: unknown): value is AppLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

/** 读取持久化的语言，缺失或非法时回退到默认中文。 */
export function loadPersistedLocale(): AppLocale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (isSupportedLocale(stored)) {
      return stored
    }
  } catch {
    // localStorage 不可用（如隐私模式）时静默回退。
  }
  return DEFAULT_LOCALE
}

/** 将选定语言持久化到 localStorage。 */
export function persistLocale(locale: AppLocale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    // 忽略持久化失败，不影响界面切换。
  }
}

const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: loadPersistedLocale(),
  fallbackLocale: DEFAULT_LOCALE,
  messages: {
    zh,
    ja,
  },
})

/** 切换当前语言并持久化。 */
export function setLocale(locale: AppLocale): void {
  i18n.global.locale.value = locale
  persistLocale(locale)
}

export default i18n
