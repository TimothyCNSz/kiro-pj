// S3 presign primitive (需求 22.6, 22.7, 22.8, 22.10)。
//
// Low-level building block for the direct-to-S3 image upload flow: the backend
// never proxies file bytes (需求 22.7). Instead it hands the client a short-
// lived presigned PUT URL (5 min, 需求 22.6/22.8) whose signature fixes the
// `Content-Type` header, and it derives the deterministic object key and the
// public CloudFront URL (`/media/<objectKey>`, 需求 22.10).
//
// This module is a *pure primitive*: it performs no auth/permission checks and
// no contentType/size *validation* — those belong to `UploadService` (task
// 6.2). Constructing the service is side-effect free (mirrors `SesMailer`): the
// S3 client and the signer are injectable so unit tests never touch real AWS,
// and a missing bucket only fails when `generatePresignedPut` is actually
// called.
//
// Requirements: 22.6, 22.7, 22.8, 22.10.

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'node:crypto'

/** 预签名 PUT URL 有效期（秒）：5 分钟（需求 22.6/22.8）。 */
export const PRESIGN_EXPIRY_SECONDS = 300

/** 单张图片大小上限缺省值（字节，5MB；需求 22.5）。 */
export const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** 上传用途：员工头像 或 商品图。 */
export type UploadPurpose = 'avatar' | 'product'

/**
 * 允许的图片 `Content-Type` -> 文件扩展名映射（需求 22.2）。
 * 仅 JPG / PNG / WebP；用于从声明的 content-type 推导 objectKey 的扩展名。
 */
export const CONTENT_TYPE_TO_EXT: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

/** CloudFront 公开读的路径前缀（需求 22.10）。 */
const MEDIA_PATH_PREFIX = 'media'

/**
 * 由图片 `Content-Type` 推导文件扩展名（`image/jpeg`→`jpg` 等）。
 * 非受支持类型返回 `undefined`（由上层 UploadService 判定为非法，task 6.2）。
 */
export const extFromContentType = (contentType: string): string | undefined =>
  CONTENT_TYPE_TO_EXT[contentType.trim().toLowerCase()]

/**
 * 生成对象存储 key：
 *   - `avatar`  -> `avatars/{ownerId}/{uuid}.{ext}`
 *   - `product` -> `products/{ownerId}/{uuid}.{ext}`
 * `ownerId` 为头像的 userId 或商品图的 productId。`uuid` 保证同一实体下多次
 * 上传互不覆盖。
 */
export const buildObjectKey = (
  purpose: UploadPurpose,
  ownerId: string,
  ext: string,
): string => {
  const folder = purpose === 'avatar' ? 'avatars' : 'products'
  return `${folder}/${ownerId}/${randomUUID()}.${ext}`
}

/**
 * 由 objectKey 构造公开访问 URL：`<MEDIA_BASE_URL>/media/<objectKey>`（需求
 * 22.10）。`baseUrl` 缺省读取 `MEDIA_BASE_URL`，末尾斜杠会被规范化。
 */
export const buildPublicUrl = (
  objectKey: string,
  baseUrl: string = process.env.MEDIA_BASE_URL ?? '',
): string => {
  const base = baseUrl.replace(/\/+$/, '')
  const key = objectKey.replace(/^\/+/, '')
  return `${base}/${MEDIA_PATH_PREFIX}/${key}`
}

/**
 * 签名函数抽象，签名与 `@aws-sdk/s3-request-presigner` 的 `getSignedUrl` 对齐。
 * 测试可注入替身以捕获入参并返回假 URL，从而不触达真实 AWS。
 */
export type PresignSigner = (
  client: S3Client,
  command: PutObjectCommand,
  options: { expiresIn: number },
) => Promise<string>

/** `generatePresignedPut` 的入参。 */
export interface GeneratePresignedPutInput {
  /** 目标对象 key（由 `buildObjectKey` 生成）。 */
  objectKey: string
  /** 声明的图片 `Content-Type`；签名将其固定，S3 侧 PUT 时须匹配（需求 22.6）。 */
  contentType: string
  /** 单张大小上限（字节）；缺省 `DEFAULT_MAX_IMAGE_BYTES`（5MB）。 */
  maxBytes?: number
}

/** `generatePresignedPut` 的返回结果。 */
export interface PresignedPut {
  /** 短时效预签名 PUT URL，客户端直传 S3（需求 22.7）。 */
  uploadUrl: string
  /** 目标对象 key。 */
  objectKey: string
  /** 被固定的 `Content-Type`（客户端 PUT 时须一致）。 */
  contentType: string
  /** 有效期（秒）。 */
  expiresIn: number
  /** content-length-range 上限（字节），S3 侧约束的大小上限（需求 22.5）。 */
  maxBytes: number
}

/** `S3PresignService` 构造选项。 */
export interface S3PresignServiceOptions {
  /** 可注入的 S3 客户端（测试传替身；缺省按 region 新建）。 */
  client?: S3Client
  /** 可注入的签名函数（测试传替身；缺省 `getSignedUrl`）。 */
  signer?: PresignSigner
  /** 上传桶名；缺省读取 `UPLOAD_BUCKET`。 */
  bucket?: string
  /** 图片公开访问基础地址；缺省读取 `MEDIA_BASE_URL`。 */
  mediaBaseUrl?: string
  /** S3 客户端 region；缺省读取 `AWS_REGION`。 */
  region?: string
}

/**
 * 基于 AWS SDK v3 的 S3 预签名原语。
 *
 * 构造函数不产生副作用（不校验/不连接）；`bucket` 缺失只在真正
 * `generatePresignedPut` 时才报错，使单元测试可在无 AWS 环境下导入依赖此类的
 * 代码。
 *
 * 生成的预签名 PUT URL 通过在 `PutObjectCommand` 上固定 `ContentType` 来约束
 * `Content-Type`（S3 在 PUT 时强制匹配，需求 22.6）；`maxBytes` 表达
 * content-length-range 的上限（需求 22.5），随结果返回供上层/S3 侧约束使用。
 */
export class S3PresignService {
  private readonly client: S3Client
  private readonly signer: PresignSigner
  private readonly bucket?: string
  private readonly mediaBaseUrl?: string

  constructor(options: S3PresignServiceOptions = {}) {
    this.bucket = options.bucket ?? process.env.UPLOAD_BUCKET
    this.mediaBaseUrl = options.mediaBaseUrl ?? process.env.MEDIA_BASE_URL
    this.signer = options.signer ?? getSignedUrl
    this.client =
      options.client ??
      new S3Client(options.region ? { region: options.region } : {})
  }

  /** 见模块级 `buildObjectKey`。 */
  buildObjectKey(purpose: UploadPurpose, ownerId: string, ext: string): string {
    return buildObjectKey(purpose, ownerId, ext)
  }

  /** 见模块级 `extFromContentType`。 */
  extFromContentType(contentType: string): string | undefined {
    return extFromContentType(contentType)
  }

  /** 用本服务配置的 `MEDIA_BASE_URL` 构造公开访问 URL。 */
  buildPublicUrl(objectKey: string): string {
    if (!this.mediaBaseUrl) {
      throw new Error(
        'MEDIA_BASE_URL is not set. A public media base URL is required to build image URLs.',
      )
    }
    return buildPublicUrl(objectKey, this.mediaBaseUrl)
  }

  /**
   * 生成有时效（5 min）的预签名 PUT URL，签名固定 `Content-Type`。
   * `maxBytes` 表达 content-length-range 上限（缺省 5MB），随结果返回。
   */
  async generatePresignedPut(input: GeneratePresignedPutInput): Promise<PresignedPut> {
    if (!this.bucket) {
      throw new Error(
        'UPLOAD_BUCKET is not set. An upload bucket is required to presign uploads.',
      )
    }

    const maxBytes = input.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.objectKey,
      // 固定 Content-Type：S3 在 PUT 时强制请求头与签名一致（需求 22.6）。
      ContentType: input.contentType,
    })

    const uploadUrl = await this.signer(this.client, command, {
      expiresIn: PRESIGN_EXPIRY_SECONDS,
    })

    return {
      uploadUrl,
      objectKey: input.objectKey,
      contentType: input.contentType,
      expiresIn: PRESIGN_EXPIRY_SECONDS,
      maxBytes,
    }
  }
}
