# AWSomeShop 基础设施（AWS CDK / TypeScript）

本目录是 AWSomeShop 演示环境的基础设施即代码（IaC），使用 **AWS CDK v2（TypeScript）**。
所有资源声明在单一主 Stack `AwsomeShopStack`（`lib/awsome-shop-stack.ts`）中，
一次 `cdk deploy` 幂等编排完成。

## 当前范围（任务 19.1）

- **前端静态资源私有 S3 桶**：Block Public Access 全开，仅经 CloudFront OAC 读取。
- **CloudFront 分发**：默认行为回源到前端桶（OAC）。
- **SPA 深链接回退**：自定义错误响应把源返回的 `403`/`404` 映射为 `/index.html`（HTTP `200`），
  交给 Vue Router 处理深链接刷新。

演示级取舍：不含 WAF、自定义域名与证书（使用 CloudFront 默认域名）。

## 后续扩展（同一 Stack）

`lib/awsome-shop-stack.ts` 内保留了「扩展锚点」注释，后续任务在同一 Stack 追加：

- **19.2**：API Gateway（HTTP API）+ 单体 Lambda + CloudFront `/api/*` behavior。
- **19.3**：RDS for PostgreSQL（公网可达 + 安全组限制来源 IP）。
- **19.4**：上传桶（OAC 读 / 预签名 PUT 写 + CORS）+ CloudFront `/media/*` behavior。
- **19.5**：SES 发件身份与 DKIM。

## 常用命令

```bash
npm install            # 安装依赖
npm run typecheck      # TypeScript 类型检查（tsc --noEmit）
npm run synth          # 合成 CloudFormation 模板（cdk synth）
npm run deploy         # 部署（cdk deploy --require-approval never）
npm run destroy        # 销毁（cdk destroy）
```

## 栈输出（Outputs）

| 输出 | 用途 |
|------|------|
| `FrontendBucketName` | 前端静态资源桶名，供 `aws s3 sync dist/ s3://<bucket>` 使用 |
| `DistributionId` | CloudFront 分发 ID，供 `aws cloudfront create-invalidation` 使用 |
| `DistributionDomainName` | CloudFront 默认域名，前端访问入口 |
