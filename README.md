# Kiro PJ

基于 Vue 3 + TypeScript + Vite 的项目模板。

## 技术栈

- **Vue 3** - Composition API
- **TypeScript** - 类型安全
- **Vite** - 构建工具
- **Vue Router 4** - 路由管理
- **Pinia** - 状态管理
- **Axios** - HTTP 请求

## 项目结构

```
src/
├── api/          # API 请求封装 (axios)
├── components/   # 公共组件
├── router/       # 路由配置
├── stores/       # Pinia 状态管理
├── styles/       # 全局样式
├── types/        # TypeScript 类型定义
├── utils/        # 工具函数
├── views/        # 页面视图
├── App.vue
└── main.ts
```

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式
npm run dev

# 构建生产版本
npm run build

# 预览构建结果
npm run preview
```

## 环境变量

复制 `.env.example` 为 `.env.local` 并按需修改：

```bash
VITE_API_BASE_URL=http://localhost:3000/api
VITE_APP_TITLE=Kiro PJ
```
