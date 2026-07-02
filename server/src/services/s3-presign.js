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
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
/** 预签名 PUT URL 有效期（秒）：5 分钟（需求 22.6/22.8）。 */
export const PRESIGN_EXPIRY_SECONDS = 300;
/** 单张图片大小上限缺省值（字节，5MB；需求 22.5）。 */
export const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/**
 * 允许的图片 `Content-Type` -> 文件扩展名映射（需求 22.2）。
 * 仅 JPG / PNG / WebP；用于从声明的 content-type 推导 objectKey 的扩展名。
 */
export const CONTENT_TYPE_TO_EXT = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
};
/** CloudFront 公开读的路径前缀（需求 22.10）。 */
const MEDIA_PATH_PREFIX = 'media';
/**
 * 由图片 `Content-Type` 推导文件扩展名（`image/jpeg`→`jpg` 等）。
 * 非受支持类型返回 `undefined`（由上层 UploadService 判定为非法，task 6.2）。
 */
export const extFromContentType = (contentType) => CONTENT_TYPE_TO_EXT[contentType.trim().toLowerCase()];
/**
 * 生成对象存储 key：
 *   - `avatar`  -> `avatars/{ownerId}/{uuid}.{ext}`
 *   - `product` -> `products/{ownerId}/{uuid}.{ext}`
 * `ownerId` 为头像的 userId 或商品图的 productId。`uuid` 保证同一实体下多次
 * 上传互不覆盖。
 */
export const buildObjectKey = (purpose, ownerId, ext) => {
    const folder = purpose === 'avatar' ? 'avatars' : 'products';
    return `${folder}/${ownerId}/${randomUUID()}.${ext}`;
};
/**
 * 由 objectKey 构造公开访问 URL：`<MEDIA_BASE_URL>/media/<objectKey>`（需求
 * 22.10）。`baseUrl` 缺省读取 `MEDIA_BASE_URL`，末尾斜杠会被规范化。
 */
export const buildPublicUrl = (objectKey, baseUrl = process.env.MEDIA_BASE_URL ?? '') => {
    const base = baseUrl.replace(/\/+$/, '');
    const key = objectKey.replace(/^\/+/, '');
    return `${base}/${MEDIA_PATH_PREFIX}/${key}`;
};
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
    client;
    signer;
    bucket;
    mediaBaseUrl;
    constructor(options = {}) {
        this.bucket = options.bucket ?? process.env.UPLOAD_BUCKET;
        this.mediaBaseUrl = options.mediaBaseUrl ?? process.env.MEDIA_BASE_URL;
        this.signer = options.signer ?? getSignedUrl;
        this.client =
            options.client ??
                new S3Client(options.region ? { region: options.region } : {});
    }
    /** 见模块级 `buildObjectKey`。 */
    buildObjectKey(purpose, ownerId, ext) {
        return buildObjectKey(purpose, ownerId, ext);
    }
    /** 见模块级 `extFromContentType`。 */
    extFromContentType(contentType) {
        return extFromContentType(contentType);
    }
    /** 用本服务配置的 `MEDIA_BASE_URL` 构造公开访问 URL。 */
    buildPublicUrl(objectKey) {
        if (!this.mediaBaseUrl) {
            throw new Error('MEDIA_BASE_URL is not set. A public media base URL is required to build image URLs.');
        }
        return buildPublicUrl(objectKey, this.mediaBaseUrl);
    }
    /**
     * 生成有时效（5 min）的预签名 PUT URL，签名固定 `Content-Type`。
     * `maxBytes` 表达 content-length-range 上限（缺省 5MB），随结果返回。
     */
    async generatePresignedPut(input) {
        if (!this.bucket) {
            throw new Error('UPLOAD_BUCKET is not set. An upload bucket is required to presign uploads.');
        }
        const maxBytes = input.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
        const command = new PutObjectCommand({
            Bucket: this.bucket,
            Key: input.objectKey,
            // 固定 Content-Type：S3 在 PUT 时强制请求头与签名一致（需求 22.6）。
            ContentType: input.contentType,
        });
        const uploadUrl = await this.signer(this.client, command, {
            expiresIn: PRESIGN_EXPIRY_SECONDS,
        });
        return {
            uploadUrl,
            objectKey: input.objectKey,
            contentType: input.contentType,
            expiresIn: PRESIGN_EXPIRY_SECONDS,
            maxBytes,
        };
    }
}
