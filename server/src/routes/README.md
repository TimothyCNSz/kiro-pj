# routes/

HTTP 路由层。

按分组挂载 API 路由（`/auth/*`、`/products/*`、`/cart/*`、`/redemptions/*`、`/orders/*`、
`/points/*`、`/uploads/*`、`/me/*`、`/admin/*`），将请求转发到对应 Service。
所有 `/admin/*` 路由经管理员 Guard；所有非 `/auth/*` 路由经认证 + 会话空闲 Guard。
