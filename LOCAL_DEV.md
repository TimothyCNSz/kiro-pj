# 本地部署与验证指南（AWSomeShop）

本项目生产环境部署在 AWS（CloudFront + S3 前端、API Gateway + Lambda 后端、RDS、SES），
见 `deploy.cmd` 与 `infra/`。本文档说明**如何在本地把整套跑起来做验证**，无需 AWS 账号。

本地架构：本地 PostgreSQL（Docker）+ 后端 Node HTTP 服务（复用同一 Express app）+
前端 Vite dev server（通过代理把 `/api` 转发到本地后端）。邮件（SES）在本地降级为
控制台打印，方便完成邮箱验证。

---

## 前置条件

- **Node.js ≥ 20.6**（本地脚本用到 `node --env-file`）。用 `node -v` 确认。
- **Docker Desktop**（用于本地 PostgreSQL）。若已有本地 Postgres 也可不用 Docker，见「不使用 Docker」。
- 已安装依赖：在项目根和 `server/` 各执行一次 `npm install`。

---

## 一、配置环境变量（含数据库）

1. 复制示例文件为项目根 `.env`：

   ```powershell
   copy .env.example .env
   ```

2. 打开 `.env`，本地验证的关键变量（示例已给出可直接用的默认值）：

   | 变量 | 本地取值 | 说明 |
   |------|----------|------|
   | `DATABASE_URL` | `postgres://app:app@localhost:5432/awsome_shop` | **数据库连接串**，与 docker-compose 的用户/密码/库名一致 |
   | `PORT` | `3000` | 后端本地监听端口 |
   | `MAILER` | `console` | 邮件降级为控制台打印（拿验证链接） |
   | `VERIFY_URL_BASE` | `http://localhost:5173/verify-email` | 验证链接指向前端验证页 |
   | `JWT_SECRET` | 任意字符串 | 本地随意，生产用强随机值 |
   | `COMPANY_EMAIL_DOMAINS` | `example.com,example-company.com` | 允许注册的邮箱域名白名单 |
   | `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | `admin@example.com` / `Admin12345` | 初始管理员种子账号 |
   | `VITE_API_BASE_URL` | `/api` | 前端走 Vite 代理，**不要**填绝对地址（会跨域） |

   > **数据库环境变量怎么加？** 后端不读取硬编码配置，全部来自环境变量。本地统一放在
   > 项目根 `.env`，后端脚本用 `node --env-file=../.env` 注入（脚本已配好）。改完 `.env`
   > 后**重启后端**即可生效。若想临时覆盖，也可在启动前 `\$env:DATABASE_URL="..."`（PowerShell）
   > 或 `set DATABASE_URL=...`（CMD）。

---

## 二、启动本地数据库

用 Docker 起 PostgreSQL：

```powershell
docker compose up -d
```

- 首次会拉取 `postgres:16-alpine` 镜像并初始化库 `awsome_shop`（用户/密码 `app`/`app`）。
- 数据持久化在命名卷 `awsome-shop-pgdata`。
- 停止：`docker compose down`；**清空数据重来**：`docker compose down -v`。

> **不使用 Docker**：自行安装 PostgreSQL 16，创建库 `awsome_shop` 与用户，然后把
> `.env` 的 `DATABASE_URL` 改成你的连接串即可。

---

## 三、准备后端（打包 + 建表 + 种子数据）

在 `server/` 目录执行：

```powershell
cd server

# 1) 打包（生成 dist/local.cjs、migrate.mjs、seed.mjs、seed-demo.mjs 等）
npm run build:backend

# 2) 建表：对本地库应用数据库迁移（幂等，可重复运行）
npm run db:migrate:local

# 3) 种子初始管理员（读取 .env 的 SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD）
npm run seed:local

# 4) （可选，强烈推荐）演示数据：示例商品/CDK + 两个演示员工（含充足积分）
npm run seed:demo:local
```

`seed:demo:local` 预置的演示员工（可直接登录，无需邮箱验证）：

| 邮箱 | 密码 | 初始积分 |
|------|------|----------|
| `demo.employee1@example-company.com` | `DemoPass!123` | 5000 |
| `demo.employee2@example-company.com` | `DemoPass!456` | 3000 |

> 上述 `*:local` 脚本都是 `node --env-file=../.env dist/xxx.mjs`，即从项目根 `.env`
> 读取 `DATABASE_URL` 等变量。若报「找不到 ../.env」，确认已在项目根创建 `.env`。

---

## 四、启动后端与前端

**两个终端**分别运行：

终端 A（后端，在 `server/`）：

```powershell
cd server
npm run start:local
```

启动后会打印：`http://localhost:3000/api`。健康检查：浏览器打开
`http://localhost:3000/api/health` 应返回 `{"code":0,"message":"ok",...}`。

> 也可用 `npm run dev`（先打包再启动，一步到位）。改了后端代码需重新 `build:backend`
> 或 `dev` 再重启。

终端 B（前端，在项目根）：

```powershell
npm run dev
```

Vite 默认在 `http://localhost:5173` 打开，`/api/*` 请求经 `vite.config.ts` 的代理转发到
`http://localhost:3000`（后端），因此不涉及跨域。

---

## 五、验证流程

1. 打开 `http://localhost:5173`。
2. **管理员登录**：用 `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`（默认 `admin@example.com` / `Admin12345`）
   登录，进入管理端配置商品、积分、发货、查看日志与低库存。
3. **员工验证核心流程**：用演示员工（如 `demo.employee1@example-company.com` / `DemoPass!123`）
   登录，走 浏览 → 加购 → 兑换 → 查看兑换记录/积分。
4. **注册 + 邮箱验证流程**（可选，验证注册链路）：
   - 用白名单域名邮箱注册（如 `someone@example-company.com`）。
   - 因 `MAILER=console`，**验证链接会打印在后端终端 A 的控制台**，形如
     `http://localhost:5173/verify-email?token=...`。复制到浏览器打开完成激活，再登录。

---

## 六、常用命令速查

| 目的 | 命令 | 目录 |
|------|------|------|
| 起/停本地数据库 | `docker compose up -d` / `docker compose down` | 根 |
| 打包后端 | `npm run build:backend` | server/ |
| 建表（迁移） | `npm run db:migrate:local` | server/ |
| 初始管理员 | `npm run seed:local` | server/ |
| 演示数据 | `npm run seed:demo:local` | server/ |
| 启动后端 | `npm run start:local` | server/ |
| 启动前端 | `npm run dev` | 根 |
| 跑后端测试 | `npm test` | server/ |

---

## 已知本地限制

- **图片上传 / 头像**：预签名上传依赖真实 S3（AWS 凭证 + 桶），本地未接入，相关功能
  （商品图集上传、头像上传）在本地不可用或会报错。核心业务流程（浏览/加购/兑换/发货/
  积分/日志）不依赖它，可正常验证。如需本地跑图片，可另接 MinIO 并改造 `s3-presign`，
  超出本文档范围。
- **真实邮件**：本地 `MAILER=console` 只打印不发信；要发真实邮件需配置 SES（生产走 `infra/`）。
- 这些取舍仅用于本地验证；生产部署见 `deploy.cmd` 与 `infra/README.md`。
