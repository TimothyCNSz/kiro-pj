# db/

数据访问层。

包含 Drizzle TS schema 定义、drizzle-kit 迁移，以及在 handler 外模块作用域初始化的
postgres.js 客户端连接（`postgres(DATABASE_URL, { max: 1-2 })` → `drizzle(sql)`，温调用复用连接）。

## 数据库迁移（部署步骤，需求 19.3）

迁移文件由 `drizzle-kit generate` 从 `schema.ts` 生成并提交到仓库（`server/drizzle/`）。
部署时**以指向 RDS 的 `DATABASE_URL` 应用已生成的迁移**——非交互、幂等（只应用尚未
应用的迁移，可反复运行）。

**执行时机**：在**基础设施就绪后（RDS 端点可用）、后端 Lambda 上线前**执行，确保新代码
所依赖的表结构已存在。

### 两种执行方式（二选一）

设置连接串后运行其一：

```cmd
:: DATABASE_URL 指向公网可达的 RDS（安全组需放行来源 IP）
set DATABASE_URL=postgresql://app:<password>@<rds-endpoint>:5432/awsomeshop
```

1. **`npm run db:migrate`** → `drizzle-kit migrate`

   - 适用场景：本地/CI 中**已安装 devDependencies**（drizzle-kit 是 devDependency）。
   - 读取 `drizzle.config.ts` 的 `out`（`./drizzle`）与 `dbCredentials.url`（`DATABASE_URL`）。

2. **`npm run db:migrate:deploy`** → `node dist/migrate.mjs`

   - 适用场景：**无 devDependencies 的精简部署环境**（不安装 drizzle-kit）。
   - `dist/migrate.mjs` 由 `npm run build:backend`（esbuild）打包，仅依赖运行时包
     （drizzle-orm + postgres.js），是自包含的 ESM 产物。
   - 迁移目录定位：runner 通过相对路径 `../drizzle` 解析（即 `dist/` 上一级的
     `server/drizzle`），因此部署产物需**将 `drizzle/` 与 `dist/` 一同发布**。
     可用 `MIGRATIONS_DIR` 环境变量覆盖迁移目录位置。

两种方式都是非交互、幂等的，可安全地作为部署流水中「RDS 就绪后、后端上线前」的一步反复执行。
