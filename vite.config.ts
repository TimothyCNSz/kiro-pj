import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    open: true,
    // 本地开发代理：把前端的 /api/* 请求转发到本地后端 HTTP 服务（server/ 的
    // start:local，默认 http://localhost:3000），避免跨域。前端 VITE_API_BASE_URL
    // 应设为相对路径 /api（见 .env.example），请求经此代理抵达后端。
    // 后端端口可用 VITE_BACKEND_PORT 覆盖（默认 3000）。
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.VITE_BACKEND_PORT ?? 3000}`,
        changeOrigin: true,
      },
    },
  },
})
