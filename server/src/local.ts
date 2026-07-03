// 本地开发 HTTP 入口（仅用于本地验证，非部署产物）。
//
// 生产环境后端以单体 Lambda 形式运行（见 handler.ts，经 API Gateway {proxy+}
// 代理到 Express app）。本地验证时并没有 API Gateway/Lambda，这里直接用同一个
// `createApp()` 起一个常规 Node HTTP server 监听端口，让前端 dev server 通过
// Vite 代理把 `/api/*` 转发过来即可完整联调。
//
// 环境变量通过 `node --env-file=../.env` 注入（见 package.json 的 start:local）；
// 需要 Node.js >= 20.6（--env-file 支持）。数据库、邮件、上传等运行期配置均取自
// 环境变量（见项目根 .env.example）。
//
// 用法（在 server/ 目录）：
//   npm run build:backend      # 先用 esbuild 打包出 dist/local.cjs
//   npm run start:local        # node --env-file=../.env dist/local.cjs

import { createApp } from './app'

const port = Number(process.env.PORT ?? 3000)
const prefix = process.env.API_PREFIX ?? '/api'

const app = createApp()

app.listen(port, () => {
  console.log('========================================================')
  console.log(`[local] AWSomeShop 后端已启动：http://localhost:${port}`)
  console.log(`[local] API 基础路径：       http://localhost:${port}${prefix}`)
  console.log(`[local] 健康检查：           http://localhost:${port}${prefix}/health`)
  console.log('========================================================')

  if (!process.env.DATABASE_URL) {
    console.warn(
      '[local] 警告：DATABASE_URL 未设置，任何数据库操作都会失败。' +
        '请在项目根 .env 中配置后重启（见 .env.example）。',
    )
  }
  if ((process.env.MAILER ?? '').toLowerCase() !== 'console') {
    console.warn(
      '[local] 提示：MAILER 未设为 console，注册验证邮件将尝试走真实 SES（本地通常会失败）。' +
        '本地建议在 .env 设置 MAILER=console，验证链接会打印到本控制台。',
    )
  }
})
