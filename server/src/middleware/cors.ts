// CORS 中间件（本地开发用；通过环境变量开启，默认关闭以不影响生产）。
//
// 生产环境前端与后端同源（都经 CloudFront，/api 走同一分发），无需 CORS。
// 本地开发前端（http://localhost:5173）直连后端（http://localhost:3000）属跨域，
// 需要后端放行。仅当设置了 `CORS_ALLOW_ORIGIN` 时启用：
//   - CORS_ALLOW_ORIGIN=*                     放行任意来源（最简单，本地够用）
//   - CORS_ALLOW_ORIGIN=http://localhost:5173  放行指定来源
//
// 未设置该变量时返回空操作中间件（生产不受影响）。

import type { RequestHandler } from 'express'

/**
 * 构造 CORS 中间件。读取 `CORS_ALLOW_ORIGIN`：
 * - 缺省/空：返回直通中间件（不加任何 CORS 头）。
 * - `*`：回显请求 Origin（或 `*`），放行任意来源。
 * - 具体来源：仅放行该来源。
 *
 * 允许 `Authorization`、`Content-Type` 请求头与常用方法；预检请求（OPTIONS）直接 204 返回。
 */
export function createCorsMiddleware(): RequestHandler {
  const allowOrigin = (process.env.CORS_ALLOW_ORIGIN ?? '').trim()

  // 未配置 → 直通（生产默认行为，不加 CORS 头）。
  if (!allowOrigin) {
    return (_req, _res, next) => next()
  }

  return (req, res, next) => {
    const requestOrigin = req.headers.origin
    // `*` 时回显请求来源（便于本地任意端口），否则用配置的固定来源。
    const originHeader =
      allowOrigin === '*' ? (requestOrigin ?? '*') : allowOrigin

    res.setHeader('Access-Control-Allow-Origin', originHeader)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    res.setHeader('Access-Control-Max-Age', '86400')

    // 预检请求：无需进入业务路由，直接结束。
    if (req.method === 'OPTIONS') {
      res.status(204).end()
      return
    }
    next()
  }
}
