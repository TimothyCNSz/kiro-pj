<template>
  <div class="products-page">
    <header class="page-header">
      <h1 class="page-title">{{ t('admin.products') }}</h1>
      <div class="header-actions">
        <BaseButton variant="secondary" type="button" :disabled="loading" @click="() => load(page)">
          {{ t('admin.productManage.refresh') }}
        </BaseButton>
        <BaseButton variant="primary" type="button" @click="openCreate">
          {{ t('admin.productCreate') }}
        </BaseButton>
      </div>
    </header>

    <!-- 全局提示 -->
    <p v-if="listError" class="alert alert-error">{{ listError }}</p>
    <p v-if="banner" class="alert alert-success">{{ banner }}</p>

    <!-- 加载中 -->
    <p v-if="loading" class="state-hint">{{ t('common.loading') }}</p>

    <!-- 空状态 -->
    <p v-else-if="rows.length === 0" class="state-hint">{{ t('admin.productManage.empty') }}</p>

    <!-- 商品列表 -->
    <table v-else class="products-table">
      <thead>
        <tr>
          <th class="col-image">{{ t('admin.productManage.colImage') }}</th>
          <th>{{ t('admin.productManage.colName') }}</th>
          <th>{{ t('admin.productManage.colType') }}</th>
          <th class="col-num">{{ t('admin.productManage.colPoints') }}</th>
          <th class="col-num">{{ t('admin.productManage.colStock') }}</th>
          <th>{{ t('admin.productManage.colStatus') }}</th>
          <th class="col-actions">{{ t('admin.productManage.colActions') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id" :class="{ 'row-selected': selectedId === row.id }">
          <td class="col-image">
            <img v-if="row.imageUrl" class="thumb" :src="row.imageUrl" :alt="row.name" />
            <span v-else class="thumb thumb-placeholder">—</span>
          </td>
          <td class="cell-name" :title="row.name">{{ row.name }}</td>
          <td>{{ typeLabel(row.type) }}</td>
          <td class="col-num">{{ row.pointsCost }}</td>
          <td class="col-num">{{ row.stock }}</td>
          <td>
            <span :class="['status-badge', row.status === 'listed' ? 'is-listed' : 'is-unlisted']">
              {{ statusLabel(row.status) }}
            </span>
          </td>
          <td class="col-actions">
            <button class="link-btn" type="button" @click="openEdit(row)">
              {{ t('common.edit') }}
            </button>
            <button
              class="link-btn"
              type="button"
              :disabled="statusBusyId === row.id"
              @click="toggleStatus(row)"
            >
              {{ row.status === 'listed' ? t('admin.productManage.actionUnlist') : t('admin.productManage.actionList') }}
            </button>
            <button class="link-btn" type="button" @click="openManage(row)">
              {{ t('admin.productManage.manageMedia') }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- 分页 -->
    <nav v-if="!loading && totalPages > 1" class="pagination">
      <button class="btn-secondary" type="button" :disabled="page <= 1" @click="() => load(page - 1)">
        {{ t('common.previous') }}
      </button>
      <span class="page-indicator">{{ page }} / {{ totalPages }}</span>
      <button class="btn-secondary" type="button" :disabled="page >= totalPages" @click="() => load(page + 1)">
        {{ t('common.next') }}
      </button>
    </nav>

    <!-- 创建 / 编辑表单弹窗 -->
    <Teleport to="body">
      <div v-if="formMode" class="modal-overlay">
        <div class="modal-card" role="dialog" aria-modal="true">
          <h2 class="modal-title">
            {{ formMode === 'create' ? t('admin.productCreate') : t('admin.productEdit') }}
          </h2>

          <form class="product-form" @submit.prevent="submitForm">
            <label class="field">
              <span class="field-label">{{ t('admin.productName') }}<em>*</em></span>
              <input v-model.trim="form.name" class="input" type="text" maxlength="120" />
              <span v-if="formErrors.name" class="field-error">{{ formErrors.name }}</span>
            </label>

            <label class="field">
              <span class="field-label">{{ t('admin.productDescription') }}</span>
              <textarea v-model.trim="form.description" class="input textarea" rows="3" maxlength="1000" />
            </label>

            <div class="field-row">
              <label class="field">
                <span class="field-label">{{ t('admin.productPrice') }}<em>*</em></span>
                <input v-model="form.pointsCost" class="input" type="number" min="0" step="1" />
                <span v-if="formErrors.pointsCost" class="field-error">{{ formErrors.pointsCost }}</span>
              </label>

              <label class="field">
                <span class="field-label">{{ t('admin.productStock') }}<em>*</em></span>
                <input v-model="form.stock" class="input" type="number" min="0" step="1" />
                <span v-if="formErrors.stock" class="field-error">{{ formErrors.stock }}</span>
                <span v-if="form.type === 'virtual'" class="field-hint">
                  {{ t('admin.productManage.stockVirtualHint') }}
                </span>
              </label>
            </div>

            <div class="field-row">
              <label class="field">
                <span class="field-label">{{ t('admin.productType') }}<em>*</em></span>
                <select v-model="form.type" class="input" :disabled="formMode === 'edit'">
                  <option value="physical">{{ t('catalog.typePhysical') }}</option>
                  <option value="virtual">{{ t('catalog.typeVirtual') }}</option>
                </select>
                <span v-if="formMode === 'edit'" class="field-hint">
                  {{ t('admin.productManage.typeLockedHint') }}
                </span>
              </label>

              <label class="field">
                <span class="field-label">{{ t('admin.productManage.colStatus') }}</span>
                <select v-model="form.status" class="input">
                  <option value="listed">{{ t('admin.productManage.statusListed') }}</option>
                  <option value="unlisted">{{ t('admin.productManage.statusUnlisted') }}</option>
                </select>
              </label>
            </div>

            <p v-if="formError" class="alert alert-error">{{ formError }}</p>

            <div class="modal-actions">
              <BaseButton variant="secondary" type="button" :disabled="saving" @click="closeForm">
                {{ t('common.cancel') }}
              </BaseButton>
              <BaseButton variant="primary" type="submit" :loading="saving">
                {{ t('common.save') }}
              </BaseButton>
            </div>
          </form>
        </div>
      </div>
    </Teleport>

    <!-- 图集 / CDK 管理弹窗 -->
    <Teleport to="body">
      <div v-if="manageRow" class="modal-overlay">
        <div class="modal-card modal-wide" role="dialog" aria-modal="true">
          <h2 class="modal-title">{{ manageRow.name }}</h2>

          <!-- 图集 -->
          <section class="panel">
            <div class="panel-head">
              <h3 class="panel-title">{{ t('admin.productImages') }}</h3>
              <span class="panel-count">
                {{ t('admin.productManage.galleryCount', { count: gallery.length, max: MAX_IMAGES }) }}
              </span>
            </div>

            <p v-if="galleryLoading" class="state-hint">{{ t('common.loading') }}</p>
            <p v-else-if="gallery.length === 0" class="state-hint">{{ t('admin.productManage.galleryEmpty') }}</p>

            <div v-else class="gallery">
              <figure v-for="img in gallery" :key="img.id" class="gallery-item">
                <img class="gallery-img" :src="img.url" :alt="manageRow.name" />
                <span v-if="img.isPrimary" class="primary-badge">{{ t('admin.productManage.primaryBadge') }}</span>
                <figcaption class="gallery-actions">
                  <button
                    v-if="!img.isPrimary"
                    class="link-btn"
                    type="button"
                    :disabled="galleryBusy"
                    @click="setPrimary(img.id)"
                  >
                    {{ t('admin.setPrimaryImage') }}
                  </button>
                  <span v-else class="primary-tag">{{ t('admin.productManage.primaryBadge') }}</span>
                  <button class="link-btn danger" type="button" :disabled="galleryBusy" @click="removeImage(img.id)">
                    {{ t('admin.removeImage') }}
                  </button>
                </figcaption>
              </figure>
            </div>

            <p v-if="galleryError" class="alert alert-error">{{ galleryError }}</p>

            <div class="panel-foot">
              <BaseButton
                variant="secondary"
                type="button"
                :loading="uploading"
                :disabled="gallery.length >= MAX_IMAGES"
                @click="pickImage"
              >
                {{ t('admin.uploadImage') }}
              </BaseButton>
              <span class="field-hint">JPG / PNG / WebP · ≤ 5MB · {{ t('admin.imageLimitHint') }}</span>
              <input
                ref="fileInput"
                class="file-input"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                @change="onFileChange"
              />
            </div>
          </section>

          <!-- 虚拟商品 CDK -->
          <section class="panel">
            <h3 class="panel-title">{{ t('admin.productManage.cdkTitle') }}</h3>

            <template v-if="manageRow.type === 'virtual'">
              <textarea
                v-model="cdkText"
                class="input textarea"
                rows="4"
                :placeholder="t('admin.productManage.cdkPlaceholder')"
              />
              <p v-if="cdkError" class="alert alert-error">{{ cdkError }}</p>
              <p v-if="cdkMessage" class="alert alert-success">{{ cdkMessage }}</p>
              <div class="panel-foot">
                <BaseButton variant="primary" type="button" :loading="cdkSubmitting" @click="addCdks">
                  {{ t('admin.productManage.cdkAdd') }}
                </BaseButton>
              </div>
            </template>
            <p v-else class="state-hint">{{ t('admin.productManage.cdkOnlyVirtual') }}</p>
          </section>

          <div class="modal-actions">
            <BaseButton variant="secondary" type="button" @click="closeManage">
              {{ t('common.close') }}
            </BaseButton>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseButton from '@/components/BaseButton.vue'
import { toApiError } from '@/api/auth'
import {
  products as productsApi,
  productImages as productImagesApi,
  type Product,
  type ProductStatus,
  type ProductType,
} from '@/api/admin'
import { getProduct, listProducts } from '@/api/catalog'
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_SIZE,
  presignProductImage,
  putToPresignedUrl,
} from '@/api/uploads'

const { t } = useI18n()

/** 单商品图片数上限（演示级，需求 22.11）。 */
const MAX_IMAGES = 5
const PAGE_SIZE = 12

/** 商品列表行：类型/状态在管理端权威可知，来源为创建/编辑响应或详情接口。 */
interface ProductRow {
  id: string
  name: string
  imageUrl: string | null
  pointsCost: number
  stock: number
  status: ProductStatus
  /** 目录列表接口不返回类型，未知时为 null，编辑/管理时按需补全 */
  type: ProductType | null
}

/** 图集项（本地视图态，随关联/设主图/删除的响应更新）。 */
interface GalleryItem {
  id: string
  url: string
  isPrimary: boolean
}

const rows = ref<ProductRow[]>([])
const page = ref(1)
const total = ref(0)
const loading = ref(false)
const listError = ref('')
const banner = ref('')
const selectedId = ref<string | null>(null)
const statusBusyId = ref<string | null>(null)

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))

// ---- 列表加载 ---------------------------------------------------------------

async function load(target = 1): Promise<void> {
  const next = Math.max(1, target)
  loading.value = true
  listError.value = ''
  try {
    const data = await listProducts({ page: next, pageSize: PAGE_SIZE })
    // 目录接口仅返回上架商品；类型未知，状态按上架填充。
    rows.value = data.list.map((item) => ({
      id: item.id,
      name: item.name,
      imageUrl: item.imageUrl,
      pointsCost: item.pointsCost,
      stock: item.stock,
      status: 'listed' as ProductStatus,
      type: null,
    }))
    total.value = data.total
    page.value = data.page || next
  } catch (err) {
    listError.value = resolveError(err)
  } finally {
    loading.value = false
  }
}

/** 将后端返回的完整商品并入列表（新建置顶，编辑就地更新）。 */
function upsertRow(product: Product): void {
  const row: ProductRow = {
    id: product.id,
    name: product.name,
    imageUrl: product.imageUrl ?? null,
    pointsCost: product.pointsCost,
    stock: product.stock,
    status: product.status,
    type: product.type,
  }
  const idx = rows.value.findIndex((r) => r.id === product.id)
  if (idx >= 0) {
    rows.value[idx] = { ...rows.value[idx], ...row }
  } else {
    rows.value.unshift(row)
    total.value += 1
  }
}

// ---- 创建 / 编辑表单 --------------------------------------------------------

type FormMode = 'create' | 'edit' | null
const formMode = ref<FormMode>(null)
const saving = ref(false)
const formError = ref('')

const form = reactive<{
  id: string
  name: string
  description: string
  pointsCost: number | string
  stock: number | string
  type: ProductType
  status: ProductStatus
}>({
  id: '',
  name: '',
  description: '',
  pointsCost: 0,
  stock: 0,
  type: 'physical',
  status: 'listed',
})

const formErrors = reactive<{ name: string; pointsCost: string; stock: string }>({
  name: '',
  pointsCost: '',
  stock: '',
})

function resetFormErrors(): void {
  formErrors.name = ''
  formErrors.pointsCost = ''
  formErrors.stock = ''
  formError.value = ''
}

function openCreate(): void {
  resetFormErrors()
  form.id = ''
  form.name = ''
  form.description = ''
  form.pointsCost = 0
  form.stock = 0
  form.type = 'physical'
  form.status = 'listed'
  formMode.value = 'create'
}

async function openEdit(row: ProductRow): Promise<void> {
  resetFormErrors()
  form.id = row.id
  form.name = row.name
  form.description = ''
  form.pointsCost = row.pointsCost
  form.stock = row.stock
  form.type = row.type ?? 'physical'
  form.status = row.status
  formMode.value = 'edit'
  // 目录列表不含描述/类型，尝试拉取详情补全（下架商品详情不可读时静默降级）。
  try {
    const detail = await getProduct(row.id)
    form.description = detail.description
    form.type = detail.type
    row.type = detail.type
  } catch {
    // 忽略：保留已知字段，编辑仍可提交
  }
}

function closeForm(): void {
  formMode.value = null
}

/** 校验非负整数（需求 12.5）。 */
function isNonNegativeInt(value: number | string): boolean {
  const n = typeof value === 'string' ? Number(value) : value
  return Number.isInteger(n) && n >= 0
}

function validateForm(): boolean {
  resetFormErrors()
  let ok = true
  if (!form.name || form.name.trim().length === 0) {
    formErrors.name = t('admin.productManage.nameRequired')
    ok = false
  }
  if (!isNonNegativeInt(form.pointsCost)) {
    formErrors.pointsCost = t('admin.productManage.pointsInvalid')
    ok = false
  }
  if (!isNonNegativeInt(form.stock)) {
    formErrors.stock = t('admin.productManage.stockInvalid')
    ok = false
  }
  return ok
}

async function submitForm(): Promise<void> {
  if (!validateForm()) return
  saving.value = true
  formError.value = ''
  const pointsCost = Number(form.pointsCost)
  const stock = Number(form.stock)
  try {
    if (formMode.value === 'create') {
      const product = await productsApi.create({
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        pointsCost,
        type: form.type,
        stock,
        status: form.status,
      })
      upsertRow(product)
    } else if (formMode.value === 'edit') {
      const updated = await productsApi.update(form.id, {
        name: form.name.trim(),
        description: form.description.trim(),
        pointsCost,
        stock,
      })
      // 编辑接口不改状态；沿用表单选择的状态若与当前不同则单独切换。
      const row = rows.value.find((r) => r.id === form.id)
      const currentStatus = row?.status ?? updated.status
      upsertRow(updated)
      if (form.status !== currentStatus) {
        const afterStatus = await productsApi.setStatus(form.id, form.status)
        upsertRow(afterStatus)
      }
    }
    banner.value = t('admin.saveSuccess')
    formMode.value = null
  } catch (err) {
    formError.value = resolveError(err)
  } finally {
    saving.value = false
  }
}

// ---- 上 / 下架切换（需求 12.4） --------------------------------------------

async function toggleStatus(row: ProductRow): Promise<void> {
  const nextStatus: ProductStatus = row.status === 'listed' ? 'unlisted' : 'listed'
  statusBusyId.value = row.id
  listError.value = ''
  try {
    const updated = await productsApi.setStatus(row.id, nextStatus)
    row.status = updated.status
    banner.value = t('admin.saveSuccess')
  } catch (err) {
    listError.value = resolveError(err)
  } finally {
    statusBusyId.value = null
  }
}

// ---- 图集 / CDK 管理 --------------------------------------------------------

const manageRow = ref<ProductRow | null>(null)
const gallery = ref<GalleryItem[]>([])
const galleryLoading = ref(false)
const galleryBusy = ref(false)
const galleryError = ref('')
const uploading = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

const cdkText = ref('')
const cdkSubmitting = ref(false)
const cdkError = ref('')
const cdkMessage = ref('')

async function openManage(row: ProductRow): Promise<void> {
  manageRow.value = row
  selectedId.value = row.id
  gallery.value = []
  galleryError.value = ''
  cdkText.value = ''
  cdkError.value = ''
  cdkMessage.value = ''
  galleryLoading.value = true
  try {
    const detail = await getProduct(row.id)
    row.type = detail.type
    gallery.value = detail.images.map((img) => ({
      id: img.id,
      url: img.url,
      isPrimary: img.isPrimary,
    }))
  } catch (err) {
    // 下架商品详情不可读（404）时从空图集开始；图集变更以关联响应为准。
    const apiErr = toApiError(err)
    if (apiErr.status !== undefined && apiErr.status !== 404) {
      galleryError.value = resolveError(err)
    }
  } finally {
    galleryLoading.value = false
  }
}

function closeManage(): void {
  manageRow.value = null
  selectedId.value = null
}

function pickImage(): void {
  galleryError.value = ''
  if (gallery.value.length >= MAX_IMAGES) {
    galleryError.value = t('admin.productManage.galleryLimitReached', { max: MAX_IMAGES })
    return
  }
  fileInput.value?.click()
}

/** 前端即时校验：格式（22.4）与大小（22.5）。 */
function validateImage(file: File): boolean {
  if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    galleryError.value = t('errors.UNSUPPORTED_IMAGE_TYPE')
    return false
  }
  if (file.size > MAX_IMAGE_SIZE) {
    galleryError.value = t('errors.IMAGE_TOO_LARGE')
    return false
  }
  return true
}

async function onFileChange(event: Event): Promise<void> {
  galleryError.value = ''
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !manageRow.value) return

  if (gallery.value.length >= MAX_IMAGES) {
    galleryError.value = t('admin.productManage.galleryLimitReached', { max: MAX_IMAGES })
    return
  }
  if (!validateImage(file)) return

  const productId = manageRow.value.id
  uploading.value = true
  try {
    // 1. 签发预签名 URL（需求 22.6）
    const { uploadUrl, objectKey, publicUrl } = await presignProductImage(
      productId,
      file.type,
      file.size,
    )
    // 2. 直传 S3，字节流不经后端（需求 22.7）
    await putToPresignedUrl(uploadUrl, file)
    // 3. 关联到商品图集（校验 ≤5 张，超限 IMAGE_LIMIT_EXCEEDED，需求 22.11、22.12）
    const image = await productImagesApi.add(productId, { objectKey, url: publicUrl })
    // 首张图片后端自动置为主图，保证图集非空恰一张主图（需求 12.9）
    if (image.isPrimary) {
      gallery.value = gallery.value.map((g) => ({ ...g, isPrimary: false }))
    }
    gallery.value.push({ id: image.id, url: image.url, isPrimary: image.isPrimary })
    // 若列表行尚无主图缩略，用新主图回填
    if (image.isPrimary && manageRow.value) {
      manageRow.value.imageUrl = image.url
    }
  } catch (err) {
    const apiErr = toApiError(err)
    if (apiErr.status === 409) {
      galleryError.value = t('admin.productManage.galleryLimitReached', { max: MAX_IMAGES })
    } else {
      galleryError.value = resolveError(err)
    }
  } finally {
    uploading.value = false
  }
}

async function setPrimary(imageId: string): Promise<void> {
  if (!manageRow.value) return
  galleryBusy.value = true
  galleryError.value = ''
  try {
    await productImagesApi.setPrimary(manageRow.value.id, imageId)
    // 原主图降级为附图，目标提升为主图（需求 12.8）
    gallery.value = gallery.value.map((g) => ({ ...g, isPrimary: g.id === imageId }))
    const primary = gallery.value.find((g) => g.id === imageId)
    if (primary && manageRow.value) manageRow.value.imageUrl = primary.url
  } catch (err) {
    galleryError.value = resolveError(err)
  } finally {
    galleryBusy.value = false
  }
}

async function removeImage(imageId: string): Promise<void> {
  if (!manageRow.value) return
  galleryBusy.value = true
  galleryError.value = ''
  try {
    await productImagesApi.remove(manageRow.value.id, imageId)
    const removed = gallery.value.find((g) => g.id === imageId)
    gallery.value = gallery.value.filter((g) => g.id !== imageId)
    // 删除主图后自动把首图提升为主图，维持「非空图集恰一张主图」（需求 12.9）
    if (removed?.isPrimary && gallery.value.length > 0) {
      gallery.value[0].isPrimary = true
      if (manageRow.value) manageRow.value.imageUrl = gallery.value[0].url
    } else if (gallery.value.length === 0 && manageRow.value) {
      manageRow.value.imageUrl = null
    }
  } catch (err) {
    galleryError.value = resolveError(err)
  } finally {
    galleryBusy.value = false
  }
}

async function addCdks(): Promise<void> {
  if (!manageRow.value) return
  cdkError.value = ''
  cdkMessage.value = ''
  const codes = cdkText.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (codes.length === 0) {
    cdkError.value = t('admin.productManage.cdkEmpty')
    return
  }
  cdkSubmitting.value = true
  try {
    const { added } = await productsApi.addCdks(manageRow.value.id, codes)
    cdkMessage.value = t('admin.productManage.cdkAdded', { count: added })
    cdkText.value = ''
    // 虚拟商品可兑换库存 = 可用 CDK 数（需求 12.2）；就地累加缓存库存展示。
    manageRow.value.stock += added
  } catch (err) {
    cdkError.value = resolveError(err)
  } finally {
    cdkSubmitting.value = false
  }
}

// ---- 展示辅助 ---------------------------------------------------------------

function typeLabel(type: ProductType | null): string {
  if (type === 'physical') return t('catalog.typePhysical')
  if (type === 'virtual') return t('catalog.typeVirtual')
  return '—'
}

function statusLabel(status: ProductStatus): string {
  return status === 'listed'
    ? t('admin.productManage.statusListed')
    : t('admin.productManage.statusUnlisted')
}

/** 将各阶段错误映射为本地化提示（对齐 ProfileView 的处理）。 */
function resolveError(err: unknown): string {
  const apiErr = toApiError(err)
  // S3 直传过期 / 被拒（预签名 URL 过期，需求 22.8）
  if (apiErr.status === 403 || apiErr.status === 410) {
    return t('errors.UPLOAD_URL_EXPIRED')
  }
  if (typeof apiErr.code === 'string') {
    const key = `errors.${apiErr.code}`
    const translated = t(key)
    if (translated !== key) return translated
  }
  if (apiErr.message) return apiErr.message
  if (apiErr.status === undefined) return t('errors.NETWORK')
  return t('errors.UNKNOWN')
}

onMounted(() => load(1))
</script>

<style scoped>
.products-page {
  max-width: 1080px;
  margin: 0 auto;
  padding: 1.5rem;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.25rem;
  gap: 1rem;
}

.page-title {
  margin: 0;
  font-size: 1.5rem;
  color: #2c3e50;
}

.header-actions {
  display: flex;
  gap: 0.75rem;
}

.products-table {
  width: 100%;
  border-collapse: collapse;
  background: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  overflow: hidden;
}

.products-table th,
.products-table td {
  padding: 0.7rem 1rem;
  text-align: left;
  font-size: 0.9rem;
  border-bottom: 1px solid #eee;
  vertical-align: middle;
}

.products-table th {
  background: #f7f9fa;
  color: #555;
  font-weight: 600;
}

.products-table tbody tr:last-child td {
  border-bottom: none;
}

.products-table tbody tr.row-selected {
  background: #f1f8f4;
}

.col-num {
  text-align: right;
  white-space: nowrap;
}

.col-image {
  width: 64px;
}

.col-actions {
  white-space: nowrap;
}

.cell-name {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #2c3e50;
}

.thumb {
  width: 44px;
  height: 44px;
  border-radius: 6px;
  object-fit: cover;
  background: #f5f6f8;
  border: 1px solid #eee;
}

.thumb-placeholder {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #bbb;
}

.status-badge {
  display: inline-block;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  font-size: 0.8rem;
}

.status-badge.is-listed {
  background: #e8f5e9;
  color: #1b5e20;
}

.status-badge.is-unlisted {
  background: #f0f0f0;
  color: #777;
}

.link-btn {
  background: none;
  border: none;
  color: #2f80ed;
  cursor: pointer;
  font-size: 0.85rem;
  padding: 0 0.4rem;
}

.link-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.link-btn.danger {
  color: #e74c3c;
}

.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  margin-top: 1.5rem;
}

.page-indicator {
  font-size: 0.9rem;
  color: #555;
}

.btn-secondary {
  padding: 0.5rem 1rem;
  font-size: 0.95rem;
  border: none;
  border-radius: 6px;
  background: #e0e0e0;
  color: #333;
  cursor: pointer;
}

.btn-secondary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.state-hint {
  padding: 1.5rem 0;
  color: #666;
  text-align: center;
}

.alert {
  margin: 0.75rem 0;
  padding: 0.6rem 0.75rem;
  border-radius: 6px;
  font-size: 0.875rem;
}

.alert-error {
  background: #fdecea;
  color: #b71c1c;
}

.alert-success {
  background: #e8f5e9;
  color: #1b5e20;
}

/* 弹窗 */
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.45);
  overflow-y: auto;
}

.modal-card {
  width: 100%;
  max-width: 520px;
  padding: 1.5rem;
  border-radius: 10px;
  background: #fff;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
}

.modal-wide {
  max-width: 680px;
}

.modal-title {
  margin: 0 0 1rem;
  font-size: 1.2rem;
  color: #2c3e50;
}

.product-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  flex: 1;
}

.field-row {
  display: flex;
  gap: 1rem;
}

.field-label {
  font-size: 0.85rem;
  color: #555;
}

.field-label em {
  color: #e74c3c;
  font-style: normal;
  margin-left: 0.15rem;
}

.field-hint {
  font-size: 0.78rem;
  color: #999;
}

.field-error {
  font-size: 0.8rem;
  color: #b71c1c;
}

.input {
  padding: 0.5rem 0.65rem;
  font-size: 0.95rem;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
  background: #fff;
}

.input:focus {
  outline: none;
  border-color: #42b983;
}

.textarea {
  resize: vertical;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 0.5rem;
}

.panel {
  margin-bottom: 1.5rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid #eee;
}

.panel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.panel-title {
  margin: 0 0 0.75rem;
  font-size: 1rem;
  color: #2c3e50;
}

.panel-count {
  font-size: 0.85rem;
  color: #888;
}

.panel-foot {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.75rem;
  flex-wrap: wrap;
}

.gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 0.75rem;
}

.gallery-item {
  position: relative;
  margin: 0;
  border: 1px solid #eee;
  border-radius: 8px;
  overflow: hidden;
  background: #fafafa;
}

.gallery-img {
  width: 100%;
  height: 96px;
  object-fit: cover;
  display: block;
}

.primary-badge {
  position: absolute;
  top: 6px;
  left: 6px;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  background: #42b983;
  color: #fff;
  font-size: 0.72rem;
}

.gallery-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.4rem 0.5rem;
}

.primary-tag {
  font-size: 0.78rem;
  color: #42b983;
}

.file-input {
  display: none;
}
</style>
