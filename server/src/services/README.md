# services/

领域业务服务层（Service Layer）。

承载业务逻辑与数据库事务边界，例如：`AuthService`、`EmailVerificationService`、
`CatalogService`、`CartService`、`RedemptionService`（单事务兑换核心）、
`FulfillmentService`、`PointsService`、`AdminProductService`、`ProductImageService`、
`AvatarService`、`UploadService`、`LogService`、`AlertService`、`AdminUserService`。

所有涉及积分与库存的写操作在此层封装于 Drizzle 数据库事务内并使用适当的并发控制。
