# middleware/

请求中间件层。

包含认证/授权中间件（JWT 校验 + 会话空闲检查）、角色 Guard（管理员权限）、
统一响应/错误序列化（错误码 → HTTP + `ApiResponse`）等横切关注点。
