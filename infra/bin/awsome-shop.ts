#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsomeShopStack } from '../lib/awsome-shop-stack';

const app = new cdk.App();

// 单一主 Stack，承载 AWSomeShop 演示环境的全部资源。
// 后续任务（19.2 API Gateway + Lambda、19.3 RDS、19.4 上传桶 + /media 与 /api behavior、
// 19.5 SES 身份/DKIM）将在同一 Stack（AwsomeShopStack）上分块扩展。
new AwsomeShopStack(app, 'AwsomeShopStack', {
  // 账号/区域由 CDK 环境变量解析（cdk deploy 时的 AWS_PROFILE / 默认凭证）。
  // 演示级：单账号、单区域，无需显式指定 env 即可 synth。
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'AWSomeShop 演示环境基础设施（前端 S3 + CloudFront，后续扩展 API/RDS/SES）',
});

app.synth();
