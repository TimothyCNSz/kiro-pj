// UploadService — 图片上传预签名的鉴权与校验（需求 22.1, 22.2, 22.3, 22.4, 22.5）。
//
// 职责（见设计「预签名上传流程」「校验策略」「关键服务接口」）：
//   presign 是「签发 → 直传 → 关联」三段流程的第一段。它在后端做**权威**的
//   意图校验后，委托底层 S3 预签名原语（{@link S3PresignService}，task 6.1）
//   生成有时效的预签名 PUT URL。图片字节流全程不经过后端（需求 22.7）。
//
//   校验分两类，顺序为「先鉴权、后格式/大小」（对齐设计时序图）：
//     1) 权限（需求 22.1 的两类上传对象 + 设计「上传相关接口鉴权」）：
//        - purpose=product（商品图）要求调用者为管理员，否则 FORBIDDEN；
//        - purpose=avatar（头像）限本人，即 targetId 必须等于当前登录 userId，
//          否则 FORBIDDEN（员工不得为他人上传头像）。
//     2) 格式与大小（需求 22.2/22.3 的限定 + 22.4/22.5 的拒绝语义）：
//        - contentType 必须属于 {image/jpeg, image/png, image/webp}，否则
//          UNSUPPORTED_IMAGE_TYPE（需求 22.4）；
//        - size 必须满足 0 < size ≤ maxBytes（缺省 5MB），否则 IMAGE_TOO_LARGE
//          （需求 22.5）。非法即拒绝、不签发 URL（防止无效对象进入直传阶段）。
//
//   校验通过后，用 contentType 推导扩展名并生成 objectKey（avatar→ownerId 为
//   userId，product→ownerId 为 targetId=productId），签发预签名 PUT URL，并
//   构造公开访问 URL（CloudFront /media/*，需求 22.10）。
//
//   底层 S3 预签名服务可注入，便于单元测试用替身而不触达真实 AWS。
//
// Requirements: 22.1, 22.2, 22.3, 22.4, 22.5.
import { ErrorCode } from '../lib/errors';
import { Role } from '../lib/domain';
import { HttpError } from '../middleware/http-error';
import { DEFAULT_MAX_IMAGE_BYTES, S3PresignService, } from './s3-presign';
/** 非法格式统一提示（需求 22.4）。 */
export const UNSUPPORTED_IMAGE_TYPE_MESSAGE = '仅支持 JPG、PNG、WebP 格式的图片';
/** 超过大小上限统一提示（需求 22.5）。 */
export const IMAGE_TOO_LARGE_MESSAGE = '单张图片大小不得超过 5MB';
/** 越权上传统一提示（设计「上传相关接口鉴权」）。 */
export const FORBIDDEN_UPLOAD_MESSAGE = '无权限上传该图片';
/**
 * 图片上传预签名服务。见模块级说明。
 * 构造无副作用（不连接 AWS）；真正签发时才需要底层桶/签名配置。
 */
export class UploadService {
    presigner;
    maxBytes;
    constructor(options = {}) {
        this.presigner = options.presigner ?? new S3PresignService();
        this.maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
    }
    /**
     * 校验鉴权 + 格式/大小意图，通过则签发预签名 PUT URL。
     *
     * 校验顺序：先权限（FORBIDDEN），后格式（UNSUPPORTED_IMAGE_TYPE）、大小
     * （IMAGE_TOO_LARGE）。任一不通过均以携带对应 `ErrorCode` 的 `HttpError`
     * 上抛，交由统一错误中间件序列化（不签发 URL）。
     */
    async presign(actor, req) {
        // 1) 权限：商品图需管理员；头像限本人（需求 22.1；设计「上传相关接口鉴权」）。
        this.authorize(actor, req);
        // 2) 格式：contentType ∈ {jpeg,png,webp}，否则 UNSUPPORTED_IMAGE_TYPE（需求 22.2/22.4）。
        const ext = this.presigner.extFromContentType(req.contentType);
        if (!ext) {
            throw new HttpError(ErrorCode.UnsupportedImageType, UNSUPPORTED_IMAGE_TYPE_MESSAGE);
        }
        // 3) 大小：0 < size ≤ maxBytes（缺省 5MB），否则 IMAGE_TOO_LARGE（需求 22.3/22.5）。
        if (!Number.isFinite(req.size) || req.size <= 0 || req.size > this.maxBytes) {
            throw new HttpError(ErrorCode.ImageTooLarge, IMAGE_TOO_LARGE_MESSAGE);
        }
        // 4) 校验通过：生成 objectKey、签发预签名 PUT URL、构造公开访问 URL。
        const ownerId = req.purpose === 'avatar' ? actor.userId : req.targetId;
        const objectKey = this.presigner.buildObjectKey(req.purpose, ownerId, ext);
        const presigned = await this.presigner.generatePresignedPut({
            objectKey,
            contentType: req.contentType,
            maxBytes: this.maxBytes,
        });
        const publicUrl = this.presigner.buildPublicUrl(presigned.objectKey);
        return {
            uploadUrl: presigned.uploadUrl,
            objectKey: presigned.objectKey,
            publicUrl,
        };
    }
    /**
     * 权限校验：
     *   - product：调用者必须是管理员；
     *   - avatar ：targetId 必须等于当前登录 userId（限本人）。
     * 不满足抛 `HttpError(FORBIDDEN)`。
     */
    authorize(actor, req) {
        if (req.purpose === 'product') {
            if (actor.role !== Role.Admin) {
                throw new HttpError(ErrorCode.Forbidden, FORBIDDEN_UPLOAD_MESSAGE);
            }
            return;
        }
        // avatar：限本人。
        if (req.targetId !== actor.userId) {
            throw new HttpError(ErrorCode.Forbidden, FORBIDDEN_UPLOAD_MESSAGE);
        }
    }
}
