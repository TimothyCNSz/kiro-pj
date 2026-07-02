// Unified error code enum for AWSomeShop.
//
// The identifiers below are the stable, self-documenting error categories from
// the design "Error Handling · 错误响应约定" table. They serve two purposes:
//   1. Stable keys the frontend maps to localized (zh/ja) i18n messages
//      (需求 17), so error text stays fully bilingual.
//   2. Semantic disambiguation for statuses that collapse multiple errors onto
//      the same HTTP code (e.g. several distinct 409 conditions).
//
// Each error also carries its HTTP status and a unique numeric `appCode`, so it
// can be surfaced through the numeric `ApiResponse.code` contract shared with
// the frontend (`src/types/index.ts`). `appCode` 0 is reserved for success.
//
// Design ref: Error Handling table (rows below map 1:1 to that table).

/** 统一错误码（字符串标识，用于 i18n 键与内部语义区分）。 */
export const ErrorCode = {
  /** 未认证 / 会话过期（401）。 */
  Unauthenticated: 'UNAUTHENTICATED',
  /** 无管理员权限（403）。 */
  Forbidden: 'FORBIDDEN',
  /** 注册/输入校验失败，含逐项 field errors（422）。 */
  Validation: 'VALIDATION',
  /** 邮箱已注册（409）。 */
  EmailTaken: 'EMAIL_TAKEN',
  /** 验证令牌已过期（410）。 */
  VerificationExpired: 'VERIFICATION_EXPIRED',
  /** 验证令牌无效 / 已消费 / 已失效（400）。 */
  VerificationInvalid: 'VERIFICATION_INVALID',
  /** 账号未验证却尝试登录（403）。 */
  EmailNotVerified: 'EMAIL_NOT_VERIFIED',
  /** 积分不足（409）。 */
  InsufficientPoints: 'INSUFFICIENT_POINTS',
  /** 库存不足 / 超卖冲突（409）。 */
  InsufficientStock: 'INSUFFICIENT_STOCK',
  /** 并发版本冲突（409）。 */
  ConcurrencyConflict: 'CONCURRENCY_CONFLICT',
  /** 缺少配送地址（422）。 */
  AddressRequired: 'ADDRESS_REQUIRED',
  /** 空物流编号（422）。 */
  TrackingRequired: 'TRACKING_REQUIRED',
  /** 非法商品数值（422）。 */
  InvalidProductField: 'INVALID_PRODUCT_FIELD',
  /** 图片格式不支持（422）。 */
  UnsupportedImageType: 'UNSUPPORTED_IMAGE_TYPE',
  /** 图片超过 5MB（422）。 */
  ImageTooLarge: 'IMAGE_TOO_LARGE',
  /** 预签名 URL 过期 / 直传失败（403，由 S3 侧拒绝）。 */
  UploadUrlExpired: 'UPLOAD_URL_EXPIRED',
  /** 商品图集超过数量上限（409）。 */
  ImageLimitExceeded: 'IMAGE_LIMIT_EXCEEDED',
} as const
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

/** 单个错误码的传输元数据。 */
export interface ErrorDefinition {
  /** 字符串错误码标识。 */
  readonly code: ErrorCode
  /** 对应的 HTTP 状态码。 */
  readonly httpStatus: number
  /** 应用级数字码，用于 `ApiResponse.code`（0 保留给成功）。 */
  readonly appCode: number
}

/**
 * 错误码注册表：每个 `ErrorCode` -> { httpStatus, appCode }。
 * `appCode` 唯一且非零，便于前端在 `ApiResponse.code` 上做数字映射；
 * 字符串 `code` 保留用于语义区分与 i18n。
 */
export const ERROR_DEFINITIONS: Readonly<Record<ErrorCode, ErrorDefinition>> = {
  [ErrorCode.Unauthenticated]: { code: ErrorCode.Unauthenticated, httpStatus: 401, appCode: 1001 },
  [ErrorCode.Forbidden]: { code: ErrorCode.Forbidden, httpStatus: 403, appCode: 1002 },
  [ErrorCode.Validation]: { code: ErrorCode.Validation, httpStatus: 422, appCode: 1003 },
  [ErrorCode.EmailTaken]: { code: ErrorCode.EmailTaken, httpStatus: 409, appCode: 1004 },
  [ErrorCode.VerificationExpired]: { code: ErrorCode.VerificationExpired, httpStatus: 410, appCode: 1005 },
  [ErrorCode.VerificationInvalid]: { code: ErrorCode.VerificationInvalid, httpStatus: 400, appCode: 1006 },
  [ErrorCode.EmailNotVerified]: { code: ErrorCode.EmailNotVerified, httpStatus: 403, appCode: 1007 },
  [ErrorCode.InsufficientPoints]: { code: ErrorCode.InsufficientPoints, httpStatus: 409, appCode: 1008 },
  [ErrorCode.InsufficientStock]: { code: ErrorCode.InsufficientStock, httpStatus: 409, appCode: 1009 },
  [ErrorCode.ConcurrencyConflict]: { code: ErrorCode.ConcurrencyConflict, httpStatus: 409, appCode: 1010 },
  [ErrorCode.AddressRequired]: { code: ErrorCode.AddressRequired, httpStatus: 422, appCode: 1011 },
  [ErrorCode.TrackingRequired]: { code: ErrorCode.TrackingRequired, httpStatus: 422, appCode: 1012 },
  [ErrorCode.InvalidProductField]: { code: ErrorCode.InvalidProductField, httpStatus: 422, appCode: 1013 },
  [ErrorCode.UnsupportedImageType]: { code: ErrorCode.UnsupportedImageType, httpStatus: 422, appCode: 1014 },
  [ErrorCode.ImageTooLarge]: { code: ErrorCode.ImageTooLarge, httpStatus: 422, appCode: 1015 },
  [ErrorCode.UploadUrlExpired]: { code: ErrorCode.UploadUrlExpired, httpStatus: 403, appCode: 1016 },
  [ErrorCode.ImageLimitExceeded]: { code: ErrorCode.ImageLimitExceeded, httpStatus: 409, appCode: 1017 },
}

/** 全部合法错误码取值。 */
export const ERROR_CODE_VALUES = Object.values(ErrorCode) as readonly ErrorCode[]

export const isErrorCode = (v: unknown): v is ErrorCode =>
  ERROR_CODE_VALUES.includes(v as ErrorCode)

/** 取某错误码的传输元数据（HTTP 状态 + 数字码）。 */
export const errorDefinition = (code: ErrorCode): ErrorDefinition => ERROR_DEFINITIONS[code]
