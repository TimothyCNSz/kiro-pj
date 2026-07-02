# Implementation Plan: AWSomeShop（AWSomeShop 实现计划）

## Overview

本计划将 AWSomeShop 的设计（Vue 3 + TS 前端，Node.js + TS 单体 Lambda 后端，Drizzle ORM + postgres.js + RDS PostgreSQL，S3/CloudFront/API Gateway/SES，CDK/SAM 编排）拆分为可增量执行、测试驱动的编码任务。

拆分策略：先搭建工程骨架与数据层（Drizzle schema + 迁移），再按功能纵向切片交付（认证/邮箱验证 → 商品与图片 → 购物车 → 兑换事务 → 发货 → 积分/历史/员工列表 → 日志/低库存提醒 → 前端视图 → i18n → 基础设施与部署 → 集成/冒烟）。每个功能切片实现后紧跟其正确性属性的属性化测试，尽早捕获错误。

约定：
- 属性化测试使用 `fast-check`（Vitest 集成），每个属性 `fc.assert(prop, { numRuns: 100 })`，一属性一测试，文件顶部注释 `// Feature: awsome-shop, Property {number}: {property_text}`。
- 标记 `*` 的子任务为可选测试任务，可跳过以加速 MVP；核心实现任务不标 `*`。
- 纯基础设施/部署/SES 沙箱/性能等非编码或需人工的项，按设计测试策略以集成/冒烟/人工方式覆盖，不强套 PBT。

## Tasks

- [x] 1. 项目骨架与后端工程搭建
  - [x] 1.1 建立后端工程结构与工具链
    - 在 `server/` 下初始化后端 TS 工程（`package.json`、`tsconfig`），加入 Drizzle ORM、`postgres`、AWS SDK v3（S3/SES）、JWT 库依赖
    - 配置 Vitest + fast-check + Supertest 测试运行器（`--run` 单次执行），配置 esbuild 打包脚本 `build:backend`
    - 建立分层目录：`services/`、`middleware/`、`db/`、`routes/`、`lib/`、`test/`
    - 更新 `.env.example` 补齐新增环境变量（`DATABASE_URL`、`JWT_SECRET`、`SES_FROM_ADDRESS`、`COMPANY_EMAIL_DOMAINS`、`SESSION_IDLE_MINUTES`、`UPLOAD_BUCKET`、`MEDIA_BASE_URL`、`MAX_IMAGE_BYTES`、`MAX_PRODUCT_IMAGES`、`SEED_ADMIN_EMAIL`、`SEED_ADMIN_PASSWORD`），便于本地开发
    - _Requirements: 19.3_
  - [x] 1.2 定义共享类型与统一响应契约
    - 定义 `ApiResponse<T>`（`{ code, message, data }`）与 `PaginatedData<T>`，与前端 `src/api/http.ts` 约定对齐
    - 定义领域类型：`Role`、账号 `status`、商品 `type`/`status`、订单 `type`/`status`、错误码枚举（见设计 Error Handling 表）
    - _Requirements: 17.2, 19.3_
  - [x] 1.3 搭建 Lambda 适配器与后端框架骨架
    - 用 Express/NestJS + Lambda 适配器（`@codegenie/serverless-express`）建立 handler，映射 API Gateway `{proxy+}` 代理事件
    - 挂载全局路由前缀与统一响应/错误序列化中间件（错误码 → HTTP + `ApiResponse`）
    - _Requirements: 19.3_

- [x] 2. 数据层：Drizzle schema 与迁移
  - [x] 2.1 定义 Drizzle TS schema
    - 定义 User、EmailVerification、Session、PointsAccount、Product、ProductImage、CDK、Cart、CartItem、Order、OrderItem、PointsLedger、OperationLog、LowStockAlert 表
    - 加入 `CHECK` 约束（`balance >= 0`、`stock >= 0`、`pointsCost >= 0`、`quantity >= 1`）、`version` 乐观锁列、唯一索引（`User.email`、`Cart.userId`、`LowStockAlert.productId`）与主图部分唯一索引 `UNIQUE (productId) WHERE isPrimary = true`
    - _Requirements: 10.3, 12.5, 13.3, 12.8, 15.1, 5.1_
  - [x] 2.2 生成并配置 drizzle-kit 迁移
    - 编写 `drizzle.config.ts`，用 `drizzle-kit generate` 从 schema 生成迁移文件并提交仓库
    - 提供非交互 `drizzle-kit migrate` 应用入口，供部署脚本调用
    - _Requirements: 19.3_
  - [x] 2.3 实现数据库连接模块
    - 在 handler 外模块作用域初始化 postgres.js 客户端（`postgres(DATABASE_URL, { max: 1-2 })`）并交给 Drizzle（`drizzle(sql)`），温调用复用连接
    - _Requirements: 19.3_
  - [ ]* 2.4 迁移应用集成测试（真实 PostgreSQL）
    - 对真实 PostgreSQL 应用迁移后校验各表、约束与部分唯一索引存在
    - _Requirements: 19.3_

- [ ] 3. 认证、会话与邮箱验证（后端）
  - [x] 3.1 实现校验工具（密码强度 + 公司邮箱域名）
    - `validatePassword(s)`：长度 ≥ 8 且至少各含一个字母与数字
    - `validateEmailDomain(email)`：域名属于 `COMPANY_EMAIL_DOMAINS` 白名单
    - _Requirements: 1.1, 1.2, 1.7_
  - [ ]* 3.2 编写密码强度校验属性测试
    - **Property 1: 密码强度校验**
    - **Validates: Requirements 1.1**
  - [ ]* 3.3 编写公司邮箱域名校验属性测试
    - **Property 2: 公司邮箱域名校验**
    - **Validates: Requirements 1.2, 1.7**
  - [x] 3.4 实现 SES 发信服务与 EmailVerificationService
    - `SesMailer`（可注入替身）封装 `SendEmail`；`EmailVerificationService.issue/validate/invalidateExisting`：生成不可猜测 token，仅存 `tokenHash` 与 `expiresAt = now + 24h`，重发前失效旧令牌
    - _Requirements: 1.4, 1.8, 1.9, 1.10, 1.11_
  - [ ]* 3.5 编写邮箱验证令牌生命周期属性测试
    - **Property 31: 邮箱验证令牌生命周期与激活闸门**
    - **Validates: Requirements 1.4, 1.8, 1.9, 1.10**
  - [ ]* 3.6 编写重发失效属性测试
    - **Property 32: 重发使旧令牌失效且仅存一枚有效令牌**
    - **Validates: Requirements 1.11**
  - [x] 3.7 实现 AuthService 注册/登录/登出
    - 注册：校验域名/强度/唯一性 → 创建 `pending_verification` 员工账号 + `PointsAccount(balance=0)` → 触发验证邮件（发送失败不回滚，返回 `emailSendFailed`）
    - 登录：仅 `active` 账号；失败提示统一为「邮箱或密码错误」；口令仅存哈希
    - 登出：终止会话
    - _Requirements: 1.3, 1.4, 1.5, 1.6, 1.12, 1.13, 1.14, 2.5_
  - [ ]* 3.8 编写注册属性测试
    - **Property 3: 注册创建待验证员工账号且拒绝重复邮箱**
    - **Validates: Requirements 1.4, 1.5**
  - [ ]* 3.9 编写登录失败不可区分属性测试
    - **Property 4: 登录失败提示不可区分**
    - **Validates: Requirements 1.14**
  - [ ]* 3.10 编写登录准入属性测试
    - **Property 33: 登录准入仅当账号已激活**
    - **Validates: Requirements 1.3, 1.12, 1.13**
  - [x] 3.11 实现会话空闲过期管理
    - 建立 `Session`（`lastActiveAt`、`expiresAt = lastActiveAt + 60min`、`revokedAt`）；`isSessionValid(session, now)` 及有效访问刷新 `lastActiveAt`
    - _Requirements: 2.1, 2.2, 2.3, 2.5_
  - [ ]* 3.12 编写会话有效性属性测试
    - **Property 5: 会话有效性不变式**
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.5**
  - [x] 3.13 实现认证中间件、角色 Guard 并挂载 /auth 路由
    - JWT 校验 + 会话空闲检查中间件；管理员 Guard；挂载 `register/verify-email/resend-verification/login/logout/me`
    - _Requirements: 1.15, 2.4, 3.1, 3.2, 3.3, 3.4, 20.1, 20.3, 20.4_
  - [ ]* 3.14 编写未登录访问被拒属性测试
    - **Property 6: 未登录访问受保护资源被拒**
    - **Validates: Requirements 1.15, 20.1, 20.3**
  - [ ]* 3.15 编写角色授权矩阵属性测试
    - **Property 7: 基于角色的授权矩阵**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 20.4**
  - [ ]* 3.16 编写认证提示与边界单元测试
    - 注册逐项报错（1.6）、未验证登录专属提示区别于凭据错误（1.13/1.14）、过期会话 401（2.4）、注册/验证/重发/发信失败提示文案（1.4/1.9/1.11）
    - _Requirements: 1.6, 1.9, 1.11, 1.13, 1.14, 2.4_

- [x] 4. 检查点 — 确保认证切片测试通过
  - 确保所有测试通过，如有疑问请询问用户。

- [x] 5. 商品浏览、搜索与商品管理（后端）
  - [x] 5.1 实现 CatalogService 列表/搜索/详情
    - `GET /products`（分页、仅上架、含名称/主图/所需积分/库存状态）、`GET /products/search?q=`（名称匹配上架）、`GET /products/:id`（含类型/图集）
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_
  - [ ]* 5.2 编写列表与搜索仅含上架商品属性测试
    - **Property 8: 员工端列表与搜索仅含上架商品**
    - **Validates: Requirements 4.1, 4.2, 4.3, 12.4**
  - [ ]* 5.3 编写商品展示字段完整属性测试
    - **Property 9: 商品展示字段完整**
    - **Validates: Requirements 4.1, 4.5**
  - [x] 5.4 实现商品模型与虚拟库存派生（可用 CDK 计数）
    - 虚拟商品可兑换库存 = `COUNT(cdk WHERE status='available')`；为 0 视为「已兑完」；管理员维护 CDK（`POST /admin/products/:id/cdks`）
    - _Requirements: 5.1, 12.2_
  - [ ]* 5.5 编写虚拟库存等于可用 CDK 数属性测试
    - **Property 10: 虚拟商品可兑换库存等于可用 CDK 数**
    - **Validates: Requirements 5.1, 12.2**
  - [x] 5.6 实现 AdminProductService 创建/编辑/上下架
    - 保存名称/图集/描述/所需积分/库存/上下架/类型；非负积分与库存校验；上/下架状态切换（`PATCH .../status`）；不提供物理删除
    - _Requirements: 12.1, 12.3, 12.4, 12.5, 12.6, 12.10_
  - [ ]* 5.7 编写商品往返一致属性测试
    - **Property 28: 商品创建/编辑往返一致**
    - **Validates: Requirements 12.1, 12.3**
  - [ ]* 5.8 编写非法商品数值被拒属性测试
    - **Property 29: 非法商品数值被拒绝**
    - **Validates: Requirements 12.5**
  - [ ]* 5.9 编写商品管理单元测试
    - 下架不可兑（12.4）、实物不强制 CDK（12.6）
    - _Requirements: 12.4, 12.6_

- [x] 6. 图片上传、商品图集与头像（后端）
  - [x] 6.1 实现 S3 预签名服务
    - 用 AWS SDK 生成有时效（5min）预签名 PUT URL，conditions 固定 `Content-Type` + `content-length-range ≤ 5MB`；生成 objectKey（`avatars/{userId}/{uuid}.{ext}`、`products/{productId}/{uuid}.{ext}`）与 publicUrl
    - _Requirements: 22.6, 22.7, 22.8, 22.10_
  - [x] 6.2 实现 UploadService.presign 校验与鉴权
    - 校验登录/权限（商品图需管理员、头像限本人）与 `contentType ∈ {jpeg,png,webp}` 且 `0 < size ≤ 5MB`，非法返回 `UNSUPPORTED_IMAGE_TYPE`/`IMAGE_TOO_LARGE`/`FORBIDDEN`
    - _Requirements: 22.1, 22.2, 22.3, 22.4, 22.5_
  - [ ]* 6.3 编写图片上传校验属性测试
    - **Property 34: 图片上传校验——签发当且仅当格式与大小合法**
    - **Validates: Requirements 22.2, 22.3, 22.4, 22.5**
  - [x] 6.4 实现 ProductImageService 图集管理
    - `addImage`（插入前 `COUNT` 校验 ≤ 5，超限 `IMAGE_LIMIT_EXCEEDED`）、`setPrimary`（原主图降级）、`removeImage`、`listImages`（非空图集自动/恒返回恰一张主图）
    - _Requirements: 12.7, 12.8, 12.9, 22.9, 22.11, 22.12_
  - [ ]* 6.5 编写商品图集不变式属性测试
    - **Property 35: 商品图集不变式（数量上限与主图唯一性）**
    - **Validates: Requirements 22.9, 22.11, 22.12, 12.8, 12.9**
  - [x] 6.6 实现 AvatarService 头像关联与回退
    - `setAvatar`（限本人，关联 objectKey → avatarUrl）、`resolveAvatarUrl`（空回退默认头像）；挂载 `POST /me/avatar`、`POST /admin/products/:id/images` 等关联接口
    - _Requirements: 22.9, 23.1, 23.2, 23.3, 23.4_
  - [ ]* 6.7 编写头像回退与更换属性测试
    - **Property 36: 头像回退与更换**
    - **Validates: Requirements 23.2, 23.4**

- [x] 7. 购物车（后端）
  - [x] 7.1 实现 CartService 服务端购物车
    - `GET /cart`、`POST /cart/items`、`PATCH /cart/items/:productId`、`DELETE /cart/items/:productId`；服务端持久化；小计与应付总额实时重算
    - _Requirements: 6.1, 6.2, 6.4, 6.5, 6.6_
  - [ ]* 7.2 编写购物车总额与持久化往返属性测试
    - **Property 12: 购物车总额不变式与持久化往返**
    - **Validates: Requirements 6.1, 6.2, 6.4, 6.5, 6.6, 7.1**
  - [x] 7.3 实现零库存与超库存拦截
    - 零库存商品禁止加购/立即兑换；购物车数量超库存阻止结算并提示
    - _Requirements: 5.2, 6.3_
  - [ ]* 7.4 编写零库存不可加购或兑换属性测试
    - **Property 11: 零库存商品不可加购或兑换**
    - **Validates: Requirements 5.2**

- [x] 8. 兑换（结算）事务（后端）
  - [x] 8.1 实现 RedemptionService 事务核心
    - `db.transaction` 内按 productId 升序 `SELECT ... FOR UPDATE` 锁行 + 版本条件更新（`WHERE version=?`，影响行数 0 视并发冲突，有限次重试）；相对扣减积分/库存
    - _Requirements: 7.4, 7.8, 7.10, 19.2, 19.4_
  - [ ]* 8.2 编写兑换原子性属性测试
    - **Property 14: 兑换原子性（整体成功或整体失败）**
    - **Validates: Requirements 7.4, 7.5, 7.6, 7.8, 9.2**
  - [ ]* 8.3 编写单次兑换事务原子一致性属性测试（内存模型）
    - **Property 16: 单次兑换事务的原子一致性（演示级）**
    - **Validates: Requirements 7.8, 19.2**
  - [x] 8.4 实现兑换前置校验（无副作用）
    - 积分 < 应付总额、任一商品请求量 > 库存、含实物但缺地址 → 拒绝且余额/库存/CDK/订单集合不变
    - _Requirements: 5.4, 5.5, 6.3, 7.3_
  - [ ]* 8.5 编写前置校验无副作用属性测试
    - **Property 13: 兑换前置校验阻止非法兑换且不产生副作用**
    - **Validates: Requirements 5.4, 5.5, 6.3, 7.3**
  - [x] 8.6 实现混合兑换按类型拆单与积分守恒
    - 同含实物/虚拟时拆分独立实物订单与虚拟订单，订单项按类型归类，积分和 = 应付总额
    - _Requirements: 7.9_
  - [ ]* 8.7 编写混合兑换拆分与积分守恒属性测试
    - **Property 15: 混合兑换按类型拆分且积分守恒**
    - **Validates: Requirements 7.9**
  - [ ]* 8.8 编写纯虚拟兑换不要求地址属性测试
    - **Property 24: 纯虚拟兑换不要求地址**
    - **Validates: Requirements 9.1**
  - [x] 8.9 兑换事务副作用集成
    - 事务内消耗虚拟 CDK、生成订单/积分流水、移除购物车已兑项、对降为 0 的库存触发低库存提醒；挂载 `POST /redemptions/checkout`、`POST /redemptions/instant`
    - 依赖：低库存提醒的去重写入能力由 AlertService（任务 12.3）提供，须在本任务之前可用（见 Task Dependency Graph：12.3 波次不晚于 8.9）
    - _Requirements: 7.5, 9.2, 5.3_
  - [ ]* 8.10 编写兑换单元测试
    - 结算/立即兑换二次确认（7.1/7.2）、成功兑换不可取消（7.7）
    - _Requirements: 7.1, 7.2, 7.7_

- [x] 9. 检查点 — 确保兑换核心测试通过
  - 确保所有测试通过，如有疑问请询问用户。

- [x] 10. 发货管理（后端）
  - [x] 10.1 实现实物发货
    - `POST /admin/orders/:id/ship-physical`：非空物流编号校验，记录编号并置「已发货」；未发货显示「待发货」；已发货展示物流（假数据明细）
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 14.1_
  - [ ]* 10.2 编写实物地址往返与发货状态属性测试
    - **Property 21: 实物订单地址往返与发货状态转换**
    - **Validates: Requirements 8.1, 8.2, 8.4, 14.1**
  - [ ]* 10.3 编写空物流编号被拒属性测试
    - **Property 22: 空物流编号被拒绝**
    - **Validates: Requirements 14.3**
  - [x] 10.4 实现虚拟发货
    - `POST /admin/orders/:id/ship-virtual`：发货前隐藏 CDK 且「待发货」；发货后关联 CDK、展示、置「已发货」
    - _Requirements: 9.3, 9.4, 14.2_
  - [ ]* 10.5 编写虚拟发货 CDK 门控属性测试
    - **Property 23: 虚拟发货前隐藏 CDK、发货后展示并置已发货**
    - **Validates: Requirements 9.3, 9.4, 14.2**

- [x] 11. 积分、兑换历史与员工列表（后端）
  - [x] 11.1 实现 PointsService 单个调整
    - `POST /admin/points/adjust`：发放/扣除，扣除后 < 0 阻止并提示余额不足；可选备注；记流水与操作日志
    - _Requirements: 13.1, 13.3, 13.5, 13.6_
  - [ ]* 11.2 编写单个积分调整属性测试
    - **Property 19: 单个积分调整精确改变余额**
    - **Validates: Requirements 13.1, 13.2**
  - [ ]* 11.3 编写余额始终非负属性测试
    - **Property 17: 积分余额始终非负**
    - **Validates: Requirements 10.3, 13.3**
  - [ ]* 11.4 编写余额=流水累积属性测试
    - **Property 18: 积分变更仅经受控流程且余额=流水累积**
    - **Validates: Requirements 10.2, 20.2**
  - [x] 11.5 实现 PointsService 批量调整（部分成功）
    - `POST /admin/points/batch-adjust`：跳过将变负的员工，其余执行；每位实际扣除者记一条操作日志
    - _Requirements: 13.2, 13.4, 13.6_
  - [ ]* 11.6 编写批量部分成功分区与日志计数属性测试
    - **Property 20: 批量扣分部分成功分区与日志计数**
    - **Validates: Requirements 13.4, 13.6**
  - [x] 11.7 实现兑换历史查询与余额接口
    - `GET /orders?page=`（时间倒序、分页、字段完整）、`GET /orders/:id`、`GET /points/balance`
    - _Requirements: 10.1, 10.2, 10.3, 11.1, 11.2, 11.3, 11.4_
  - [ ]* 11.8 编写历史字段/倒序/分页完整属性测试
    - **Property 26: 兑换历史字段完整、时间倒序与分页完整**
    - **Validates: Requirements 11.1, 11.2, 11.3**
  - [x] 11.9 实现 AdminUserService 员工列表
    - `GET /admin/users?q=&page=`：按邮箱关键字过滤 + 分页，每项含 email/role/status/balance；空状态；供积分操作选择目标
    - _Requirements: 24.1, 24.2, 24.3, 24.4, 24.5_
  - [ ]* 11.10 编写员工列表搜索与分页完整属性测试
    - **Property 37: 员工列表搜索与分页完整性**
    - **Validates: Requirements 24.1, 24.2, 24.4**

- [x] 12. 操作日志与低库存提醒（后端）
  - [x] 12.1 实现 LogService 操作日志
    - 商品增改/上下架、积分发放/扣除、实物/虚拟发货各记一条含操作人/类型/对象/时间的日志；`GET /admin/logs?page=` 时间倒序
    - _Requirements: 16.1, 16.2, 14.4_
  - [ ]* 12.2 编写操作日志完整性与倒序属性测试
    - **Property 27: 操作日志完整性与时间倒序**
    - **Validates: Requirements 16.1, 16.2, 14.4**
  - [x] 12.3 实现 AlertService 低库存提醒（去重）
    - 库存降为 0 时唯一触发（`LowStockAlert.productId` 唯一，不重复）；`GET /admin/alerts/low-stock` 展示
    - 说明：本服务的低库存提醒去重写入能力被兑换事务副作用（任务 8.9）调用，故其写入能力须不晚于 8.9 可用（依赖图中 12.3 已提前至 8.9 之前的波次）；`GET /admin/alerts/low-stock` 展示接口可稍后完善
    - _Requirements: 5.3, 15.1, 15.2_
  - [ ]* 12.4 编写低库存提醒唯一触发属性测试
    - **Property 25: 低库存提醒在库存降为 0 时唯一触发（去重）**
    - **Validates: Requirements 5.3, 15.1**

- [x] 13. 检查点 — 确保后端全部测试通过
  - 确保所有测试通过，如有疑问请询问用户。

- [x] 14. 前端：鉴权、路由守卫与 HTTP 集成
  - [x] 14.1 实现 auth Pinia store 与路由守卫
    - `stores/auth.ts`（会话/角色/token）；`router` `beforeEach` 未登录/非管理员重定向；`http.ts` Bearer 与 401 处理对齐
    - _Requirements: 1.15, 2.4, 3.1, 3.2, 3.3_
  - [x] 14.2 实现 auth API 客户端与认证视图
    - `api/auth.ts`；`LoginView`/`RegisterView`/`VerifyEmailView`（处理验证链接/验证码 + 重发）
    - _Requirements: 1.4, 1.9, 1.10, 1.11, 1.12, 1.13_
  - [ ]* 14.3 编写前端鉴权单元测试
    - 路由守卫重定向、401 清 token 跳登录
    - _Requirements: 1.15, 2.4_

- [x] 15. 前端：商品/购物车/兑换/账户视图
  - [x] 15.1 实现 catalog store/API 与商品视图
    - `stores/catalog.ts`、`api/catalog.ts`；`CatalogView`/`ProductDetailView`（主图/图集/占位图、空搜索状态）
    - _Requirements: 4.1, 4.4, 4.5, 4.6_
  - [x] 15.2 实现 cart store/API 与购物车视图
    - `stores/cart.ts`、`api/cart.ts`；`CartView`（数量调整、移除、小计/总额、超库存提示）
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_
  - [x] 15.3 实现兑换流程视图
    - `api/redemption.ts`；`CheckoutView` + `ConfirmDialog` 二次确认 + `AddressForm`（实物必填地址）；立即兑换；积分/库存不足提示
    - _Requirements: 7.1, 7.2, 7.3, 7.6, 5.4, 5.5_
  - [x] 15.4 实现账户视图（余额/历史/订单详情）
    - `PointsView`、`HistoryView`（倒序/分页/空态）、`OrderDetailView`（实物物流 / 虚拟 CDK 视状态展示）
    - _Requirements: 8.3, 9.3, 9.4, 10.1, 11.1, 11.4_
  - [x] 15.5 实现头像上传与个人资料
    - 个人资料页头像上传：调用 presign → 预签名直传 S3 → 关联 `/me/avatar`；未设置显示默认头像；前端即时校验格式/大小
    - 提供并引用默认头像静态资源（前端内置资源或约定公开 URL），供 `avatarUrl` 为空时回退展示
    - _Requirements: 22.6, 22.7, 23.1, 23.2, 23.3, 23.4_

- [x] 16. 前端：管理端视图
  - [x] 16.1 实现 admin API 客户端
    - `api/admin.ts`（商品/积分/发货/日志/低库存/员工/商品图）
    - _Requirements: 3.2_
  - [x] 16.2 实现商品管理视图
    - `AdminProductsView`：创建/编辑/上下架、图集上传（≤5 张）/设主图、虚拟商品 CDK 维护
    - _Requirements: 12.1, 12.2, 12.4, 12.7, 12.8, 22.11, 22.12_
  - [x] 16.3 实现积分管理与员工列表视图
    - `AdminUsersView`（搜索/分页/余额、单选/多选）→ 转 `AdminPointsView` 单个/批量调整（部分成功明细）
    - _Requirements: 13.1, 13.2, 13.4, 24.1, 24.3, 24.5_
  - [x] 16.4 实现发货管理视图
    - `AdminFulfillmentView`：实物上传物流编号（非空校验）、虚拟发货关联 CDK
    - _Requirements: 8.2, 9.4, 14.1, 14.2, 14.3_
  - [x] 16.5 实现操作日志与低库存 Dashboard
    - `AdminLogsView`（时间倒序）、`AdminDashboardView`（低库存提醒）
    - _Requirements: 15.2, 16.2_

- [x] 17. 国际化（中日双语）
  - [x] 17.1 配置 vue-i18n 与中日文案
    - `i18n/index.ts`（默认中文）、`locales/zh.ts`、`locales/ja.ts`（覆盖全部面向用户文案与错误码映射）、`LanguageSwitcher`
    - _Requirements: 17.1, 17.2, 17.3_
  - [ ]* 17.2 编写 i18n 文案键对齐属性测试
    - **Property 30: i18n 文案键完整对齐且切换取对应语言**
    - **Validates: Requirements 17.2, 17.3**

- [x] 18. 检查点 — 确保前端与 i18n 测试通过
  - 确保所有测试通过，如有疑问请询问用户。

- [x] 19. 基础设施编排（CDK/SAM，TypeScript）
  - [x] 19.1 搭建 IaC 骨架 + 前端 S3 + CloudFront
    - CDK/SAM stack；前端私有 S3（OAC）+ CloudFront 默认行为回源；SPA 深链接 403/404 → `/index.html`（200）
    - _Requirements: 19.3_
  - [x] 19.2 定义 API Gateway + 单体 Lambda
    - HTTP API `{proxy+}` + proxy 集成；无 VPC Lambda；环境变量注入（DATABASE_URL/JWT_SECRET/SES_FROM_ADDRESS/COMPANY_EMAIL_DOMAINS/SESSION_IDLE_MINUTES/UPLOAD_BUCKET/MEDIA_BASE_URL/MAX_IMAGE_BYTES/MAX_PRODUCT_IMAGES）；IAM 限定 `s3:PutObject` 到上传桶前缀
    - _Requirements: 19.3, 20.5_
  - [x] 19.3 定义 RDS PostgreSQL（公网可达）
    - public subnet + `publiclyAccessible`；安全组仅放行受限来源 IP + DB 端口；强口令
    - _Requirements: 19.3, 20.5_
  - [x] 19.4 定义上传桶 + CloudFront /media 行为 + CORS
    - 独立上传桶（Block Public Access 开启，OAC 读、预签名 PUT 写）；同分发新增 `/media/*` 与 `/api/*` behavior；上传桶 CORS 允许前端域名 PUT
    - _Requirements: 22.6, 22.7, 22.10_
  - [x] 19.5 声明 SES 发件身份与 DKIM
    - IaC 声明发件域名/地址身份与 DKIM
    - _Requirements: 1.4_

- [x] 20. 迁移应用、种子管理员与部署脚本
  - [x] 20.1 实现数据库迁移部署步骤
    - 部署脚本以指向 RDS 的 `DATABASE_URL` 调用 `drizzle-kit migrate`（非交互、幂等），在 RDS 就绪后、后端上线前执行
    - _Requirements: 19.3_
  - [x] 20.2 实现初始管理员种子脚本（幂等）
    - `npm run seed`：读 `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`，用 Drizzle upsert 一个 `role=admin`/`status=active` 用户 + `PointsAccount(balance=0)`；口令仅存哈希；以 email 唯一键幂等（`onConflictDoNothing`）
    - _Requirements: 3.5, 3.6, 3.7_
  - [ ]* 20.3 编写种子集成测试
    - 校验库中恰一个 `role=admin`/`status=active` 种子账号、`passwordHash` 非空、可登录、重复执行幂等
    - _Requirements: 3.6_
  - [x] 20.4 实现前后端部署与发布脚本
    - `build:backend`（esbuild 打包）；`aws s3 sync dist/` + `cloudfront create-invalidation`；串联 `deploy.cmd`（IaC → 迁移 → seed → 后端 → 前端 → 失效）
    - _Requirements: 19.3_
  - [x] 20.5 实现演示种子数据脚本（可选运行）
    - `npm run seed:demo`：用 Drizzle 预置**示例商品**（实物与虚拟各若干、`status=上架`、含 `pointsCost`/`stock` 及图集占位 URL），**虚拟商品的示例 CDK**（`status=available`），以及 **1~2 个示例员工账号**（`status=active`）及其 `PointsAccount` 初始积分余额，便于打开即可演示浏览 → 加购 → 兑换 → 发货全流程
    - 与初始管理员种子（任务 20.2）分离、可独立运行；以稳定业务键（如商品名/员工邮箱）幂等（`onConflictDoNothing`）；口令仅存哈希；仅用于演示环境（生产不运行）
    - 依赖：须在 schema/迁移（第 2 节）之后执行；对齐项目「演示定位」与需求 4/5/12（示例商品供浏览/兑换）
    - _Requirements: 4.1, 5.1, 12.1, 12.2_

- [ ] 21. 集成与冒烟测试
  - [ ]* 21.1 编写权限 Guard 集成测试
    - 真实路由上员工访问管理端被拒（403）、未登录/过期会话被拒（401）
    - _Requirements: 3.3, 3.4, 20.1, 20.3, 20.4, 24.6_
  - [ ]* 21.2 编写注册→验证→登录端到端集成测试
    - 真实 PostgreSQL（mock SES）：注册 → 取库中令牌 → 验证 → 登录成功；未验证登录被拒
    - _Requirements: 1.4, 1.9, 1.12, 1.13_
  - [ ]* 21.3 编写单次兑换原子性集成测试
    - 真实 PostgreSQL 上 `db.transaction` 整体成功/整体回滚；1~3 个代表性并发场景示意（演示级）
    - _Requirements: 7.8, 7.10, 19.2, 19.4_
  - [ ]* 21.4 编写数据持久化集成测试
    - 经 API 写入后重连读取仍存在
    - _Requirements: 19.3_
  - [ ]* 21.5 编写预签名直传 S3 冒烟测试
    - 签发短时效 PUT URL 直传合法图片成功（后端不经手字节）；过期后 PUT 返回 403
    - _Requirements: 22.6, 22.7, 22.8_
  - [ ]* 21.6 编写 CloudFront 公开读与上传桶 CORS 冒烟测试
    - 经 `/media/<objectKey>` 公开 GET 返回 200 且可缓存；浏览器跨域 PUT 预检/直传被允许
    - _Requirements: 22.10_
  - [ ]* 21.7 编写 Lambda 公网直连 RDS/SES 网络路径冒烟测试
    - 无 VPC Lambda 经公网直连 RDS 完成一次读写、直连 SES 端点发信
    - _Requirements: 19.3, 20.5_
  - [ ]* 21.8 编写 SES 真实发信冒烟测试
    - 受控环境向已验证收件地址跑 1~2 个真实发信用例，确认验证邮件可投递、链接可点击
    - _Requirements: 1.4_

- [x] 22. 最终检查点 — 确保全部测试通过
  - 确保所有测试通过，如有疑问请询问用户。

## Notes

- 标记 `*` 的子任务为可选（单元/属性/集成/冒烟测试），可跳过以加速 MVP；核心实现任务不标 `*`。
- 每个任务引用其覆盖的需求条款；属性化测试任务显式引用设计中的 Property 编号与其校验的需求。
- 属性化测试统一用 fast-check，`numRuns: 100`，一属性一测试，文件顶部注释 `// Feature: awsome-shop, Property {number}: {property_text}`。
- 兑换原子性（Property 14/16）、批量部分成功（Property 20）、图集不变式（Property 35）、令牌生命周期（Property 31/32）、图片校验（Property 34）等核心属性均有独立任务。
- 基础设施/部署/SES 沙箱/网络路径/性能等非编码或需人工项，按设计以集成/冒烟/人工方式覆盖，不强套 PBT。
- 低库存提醒：AlertService（任务 12.3）的去重写入能力被兑换事务副作用（任务 8.9）调用，依赖图中 12.3 已提前至 8.9 之前的波次（wave 9 < wave 10），消除先后倒置；Property 25 测试（任务 12.4）位于实现之后的波次。
- 演示种子数据（任务 20.5，`npm run seed:demo`）与初始管理员种子（任务 20.2）分离、可独立运行、幂等、仅用于演示环境，须在数据库迁移（任务 20.1）之后执行。
- 检查点用于增量验证，遇疑问请与用户确认。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3"] },
    { "id": 3, "tasks": ["2.4", "3.1", "3.4"] },
    { "id": 4, "tasks": ["3.2", "3.3", "3.5", "3.6", "3.7", "3.11"] },
    { "id": 5, "tasks": ["3.8", "3.9", "3.10", "3.12", "3.13"] },
    { "id": 6, "tasks": ["3.14", "3.15", "3.16", "5.1", "5.4", "5.6"] },
    { "id": 7, "tasks": ["5.2", "5.3", "5.5", "5.7", "5.8", "5.9", "6.1"] },
    { "id": 8, "tasks": ["6.2", "6.4", "6.6", "7.1", "7.3"] },
    { "id": 9, "tasks": ["6.3", "6.5", "6.7", "7.2", "7.4", "8.1", "12.3"] },
    { "id": 10, "tasks": ["8.2", "8.3", "8.4", "8.6", "8.9"] },
    { "id": 11, "tasks": ["8.5", "8.7", "8.8", "8.10", "10.1", "10.4", "11.1", "11.5", "11.7", "11.9", "12.1"] },
    { "id": 12, "tasks": ["10.2", "10.3", "10.5", "11.2", "11.3", "11.4", "11.6", "11.8", "11.10", "12.2", "12.4"] },
    { "id": 13, "tasks": ["14.1", "14.2", "17.1"] },
    { "id": 14, "tasks": ["14.3", "15.1", "15.2", "15.3", "15.4", "15.5", "16.1", "17.2"] },
    { "id": 15, "tasks": ["16.2", "16.3", "16.4", "16.5"] },
    { "id": 16, "tasks": ["19.1", "19.2", "19.3", "19.4", "19.5"] },
    { "id": 17, "tasks": ["20.1", "20.2", "20.4"] },
    { "id": 18, "tasks": ["20.3", "20.5", "21.1", "21.2", "21.3", "21.4", "21.5", "21.6", "21.7", "21.8"] }
  ]
}
```
