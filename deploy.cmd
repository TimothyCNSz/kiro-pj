@echo off
setlocal EnableExtensions EnableDelayedExpansion

:: =============================================================================
:: AWSomeShop 一键部署脚本（Windows / CMD）
:: 任务 20.4：串联「后端打包 -> IaC 部署 -> 迁移 -> seed -> 前端构建 -> S3 同步 -> CloudFront 失效」
:: 需求：19.3（真实 AWS 架构部署：CloudFront+S3 前端、APIGW+Lambda 后端、RDS、SES）
:: -----------------------------------------------------------------------------
:: 顺序说明（为什么这样排，而非照抄 design 的 mermaid 步骤号）：
::   CDK 的 Lambda 代码来自 `server/dist`（stack: lambda.Code.fromAsset('../server/dist')）。
::   因此**必须先 `build:backend` 生成/刷新 server/dist，再 `cdk deploy`**，否则 Lambda
::   打进去的是旧产物（甚至目录不存在导致 synth 失败）。故正确顺序为：
::     1) 后端 esbuild 打包（server/dist 就绪）
::     2) IaC 首轮部署（创建 S3/CloudFront/APIGW/Lambda/RDS/SES；Lambda 打进最新代码）
::     3) 读取栈输出 + 从 Secrets Manager 组装 DATABASE_URL
::     4) 数据库迁移（RDS 就绪后、后端对外前，幂等、非交互）
::     5) 种子初始管理员（迁移后、后端对外前，幂等）
::     6) IaC 二轮部署（把真实 DATABASE_URL 等注入 Lambda 环境变量）
::     7) 前端构建 + S3 同步 + CloudFront 失效
::   步骤 3~4 存在「鸡生蛋」：DATABASE_URL 依赖首轮部署才创建出来的 RDS 端点与口令 Secret，
::   因此迁移/seed 必须在首轮 cdk deploy 之后；随后再二轮 deploy 把真实连接串下发给 Lambda。
:: -----------------------------------------------------------------------------
:: 前置要求：
::   - 已安装并登录 AWS CLI v2（`aws configure` / SSO），凭据有权限操作对应资源
::   - 已安装 Node.js 20+ 与各目录依赖（根 / server / infra 均已 `npm install`）
::   - 运行本机的**出口公网 IP** 已通过 ALLOWED_DB_CIDR 放行到 RDS 5432（否则迁移/seed 无法直连）
::
:: 部署者需提供的参数（通过环境变量传入；下方给出占位默认，务必替换真实值）：
::   set JWT_SECRET=<强随机密钥>                     签发/校验 JWT 的密钥（生产改用 SSM SecureString）
::   set ALLOWED_DB_CIDR=<你的出口IP>/32             放行连接 RDS(5432) 的来源 CIDR（如 203.0.113.10/32）
::   set SES_SENDING_DOMAIN=<你已验证的发件域名>       SES 发件域名身份（需与发件地址域名一致）
::   set SES_FROM_ADDRESS=no-reply@<发件域名>          验证邮件发件地址（须落在 SES_SENDING_DOMAIN 之下）
::   set COMPANY_EMAIL_DOMAINS=corp.example.com        允许注册的公司邮箱域名白名单（逗号分隔）
::   set SEED_ADMIN_EMAIL=admin@corp.example.com       初始管理员邮箱（仅 seed 消费，一次性）
::   set SEED_ADMIN_PASSWORD=<一次性初始口令>           初始管理员口令（仅 seed 消费；脚本内哈希入库，不落明文）
::   可选：
::   set STACK_NAME=AwsomeShopStack                    CloudFormation 栈名（默认 AwsomeShopStack）
::   set UPLOAD_CORS_ALLOWED_ORIGIN=*                  上传桶 CORS 允许来源（生产收敛为前端域名）
::   set DATABASE_URL=postgres://...                   若已自备连接串，脚本将跳过自动组装
::
:: 用法：在项目根目录执行  deploy.cmd  （或 npm run deploy）
:: 本脚本任一步失败即中止（检查 errorlevel），并以退出码 1 结束。
:: =============================================================================

if "%STACK_NAME%"=="" set "STACK_NAME=AwsomeShopStack"
if "%UPLOAD_CORS_ALLOWED_ORIGIN%"=="" set "UPLOAD_CORS_ALLOWED_ORIGIN=*"

echo(
echo === AWSomeShop 部署开始（栈：%STACK_NAME%）===
echo(

:: 校验必填参数（缺失即中止，避免把占位/空值部署上去）。
call :require_var JWT_SECRET            || goto :err
call :require_var ALLOWED_DB_CIDR       || goto :err
call :require_var SES_SENDING_DOMAIN    || goto :err
call :require_var SES_FROM_ADDRESS      || goto :err
call :require_var COMPANY_EMAIL_DOMAINS || goto :err
call :require_var SEED_ADMIN_EMAIL      || goto :err
call :require_var SEED_ADMIN_PASSWORD   || goto :err

:: -----------------------------------------------------------------------------
:: [1/7] 后端 esbuild 打包（先于 cdk deploy：Lambda 代码取自 server/dist）
:: 产出 server/dist/handler.js（Lambda 入口）、dist/migrate.mjs、dist/seed.mjs
:: -----------------------------------------------------------------------------
echo [1/7] 后端 esbuild 打包（server/dist）...
pushd server || goto :err
call npm run build:backend
if errorlevel 1 ( popd & goto :err )
popd

:: -----------------------------------------------------------------------------
:: [2/7] IaC 首轮部署：创建/更新全部基础设施（Lambda 打进步骤 1 的最新产物）
:: 此轮 DatabaseUrl 仍用栈默认占位（RDS 端点/口令尚未产出，无法在此刻组装真实连接串）；
:: 待步骤 6 二轮部署再注入真实 DATABASE_URL。其余参数此刻即可下发真实值。
:: -----------------------------------------------------------------------------
echo [2/7] IaC 部署（cdk deploy 首轮：创建 S3/CloudFront/APIGW/Lambda/RDS/SES）...
pushd infra || goto :err
call npx cdk deploy --require-approval never ^
  --parameters JwtSecret=%JWT_SECRET% ^
  --parameters AllowedDbCidr=%ALLOWED_DB_CIDR% ^
  --parameters SesSendingDomain=%SES_SENDING_DOMAIN% ^
  --parameters SesFromAddress=%SES_FROM_ADDRESS% ^
  --parameters CompanyEmailDomains=%COMPANY_EMAIL_DOMAINS% ^
  --parameters UploadCorsAllowedOrigin=%UPLOAD_CORS_ALLOWED_ORIGIN%
if errorlevel 1 ( popd & goto :err )
popd

:: -----------------------------------------------------------------------------
:: [3/7] 读取栈输出（供迁移/seed/前端发布消费）
:: 使用 `aws cloudformation describe-stacks --query` 精确抽取各 OutputValue。
:: 相关输出（见 infra 的 createOutputs）：FrontendBucketName、DistributionId、
::   DbEndpointAddress、DbEndpointPort、DbSecretArn。
:: -----------------------------------------------------------------------------
echo [3/7] 读取栈输出并组装 DATABASE_URL...
call :read_output FRONTEND_BUCKET  FrontendBucketName || goto :err
call :read_output DISTRIBUTION_ID  DistributionId     || goto :err
call :read_output DB_HOST          DbEndpointAddress   || goto :err
call :read_output DB_PORT          DbEndpointPort      || goto :err
call :read_output DB_SECRET_ARN    DbSecretArn         || goto :err

echo     FrontendBucketName = %FRONTEND_BUCKET%
echo     DistributionId     = %DISTRIBUTION_ID%
echo     DbEndpoint         = %DB_HOST%:%DB_PORT%

:: 若部署者未自备 DATABASE_URL，则从 Secrets Manager 取 RDS 主口令并组装连接串。
:: RDS 口令由 Secrets Manager 生成（用户名 app、库名 awsome_shop，见 infra createDatabase）。
:: 用 PowerShell 解析 Secret JSON 并对口令做 URL 编码，拼成 postgres 连接串。
if not "%DATABASE_URL%"=="" (
  echo     使用外部提供的 DATABASE_URL（跳过自动组装）。
) else (
  for /f "usebackq delims=" %%u in (`powershell -NoProfile -Command ^
    "$s = aws secretsmanager get-secret-value --secret-id '%DB_SECRET_ARN%' --query SecretString --output text | ConvertFrom-Json;" ^
    "'postgres://' + $s.username + ':' + [uri]::EscapeDataString($s.password) + '@' + '%DB_HOST%' + ':' + '%DB_PORT%' + '/awsome_shop'"`) do set "DATABASE_URL=%%u"
  if errorlevel 1 goto :err
  if "!DATABASE_URL!"=="" (
    echo [错误] 无法从 Secrets Manager 组装 DATABASE_URL，请检查 DbSecretArn 与 AWS 凭据权限。
    goto :err
  )
  echo     已从 Secrets Manager 组装 DATABASE_URL（口令不回显）。
)

:: -----------------------------------------------------------------------------
:: [4/7] 数据库迁移（RDS 就绪后、后端对外前；幂等、非交互）
:: 运行 server 的 dist/migrate.mjs（db:migrate:deploy），只应用尚未应用的迁移。
:: -----------------------------------------------------------------------------
echo [4/7] 执行数据库迁移（db:migrate:deploy）...
pushd server || goto :err
call npm run db:migrate:deploy
if errorlevel 1 ( popd & goto :err )
popd

:: -----------------------------------------------------------------------------
:: [5/7] 种子初始管理员（迁移后、后端对外前；幂等，仅首次实际插入）
:: seed 读取 DATABASE_URL / SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD，
:: 口令在脚本内哈希后入库，不落明文；以 email 唯一键 onConflictDoNothing 幂等。
:: -----------------------------------------------------------------------------
echo [5/7] 种子初始管理员（幂等）...
pushd server || goto :err
call npm run seed
if errorlevel 1 ( popd & goto :err )
popd

:: -----------------------------------------------------------------------------
:: [6/7] IaC 二轮部署：把真实 DATABASE_URL 注入 Lambda 环境变量
:: 首轮部署时 RDS 尚未产出连接串，Lambda 使用占位 DatabaseUrl；此轮用真实值覆盖，
:: 使后端上线即可连库。其余参数与首轮保持一致。
:: -----------------------------------------------------------------------------
echo [6/7] IaC 二轮部署（注入真实 DATABASE_URL 到 Lambda）...
pushd infra || goto :err
call npx cdk deploy --require-approval never ^
  --parameters DatabaseUrl=%DATABASE_URL% ^
  --parameters JwtSecret=%JWT_SECRET% ^
  --parameters AllowedDbCidr=%ALLOWED_DB_CIDR% ^
  --parameters SesSendingDomain=%SES_SENDING_DOMAIN% ^
  --parameters SesFromAddress=%SES_FROM_ADDRESS% ^
  --parameters CompanyEmailDomains=%COMPANY_EMAIL_DOMAINS% ^
  --parameters UploadCorsAllowedOrigin=%UPLOAD_CORS_ALLOWED_ORIGIN%
if errorlevel 1 ( popd & goto :err )
popd

:: -----------------------------------------------------------------------------
:: [7/7] 前端构建 + 发布：vite 构建 -> S3 同步（--delete 清旧）-> CloudFront 失效
:: 说明：前端沿用既有 `npm run build`（= vue-tsc -b && vite build）。若该环境曾因缺失
::   @types/node / @tsconfig/node22 导致 node 侧 tsconfig 类型检查报错，请先补齐相应
::   devDependencies（本任务不修复该依赖问题）；如需临时绕过类型检查，可改用
::   `npm run build:frontend`（= vite build，跳过 vue-tsc）。
:: -----------------------------------------------------------------------------
echo [7/7] 前端构建并发布（build -> s3 sync -> invalidation）...
call npm run build
if errorlevel 1 goto :err

echo     同步 dist/ 到 s3://%FRONTEND_BUCKET%/ ...
call aws s3 sync dist/ s3://%FRONTEND_BUCKET%/ --delete
if errorlevel 1 goto :err

echo     创建 CloudFront 失效（/*）...
call aws cloudfront create-invalidation --distribution-id %DISTRIBUTION_ID% --paths "/*"
if errorlevel 1 goto :err

echo(
echo === 部署完成 ===
echo 访问入口：CloudFront 分发域名（见栈输出 DistributionDomainName）。
echo 首次演示前请确认：SES 已移出 sandbox、发件域名 DKIM 已生效（见栈输出 SesSendingIdentityName）。
endlocal
exit /b 0

:: -----------------------------------------------------------------------------
:: 子例程：require_var —— 校验环境变量非空，缺失则报错并返回 1
:: -----------------------------------------------------------------------------
:require_var
if "!%~1!"=="" (
  echo [错误] 缺少必填参数 %~1，请先 `set %~1=...` 后重试。
  exit /b 1
)
exit /b 0

:: -----------------------------------------------------------------------------
:: 子例程：read_output <目标变量名> <栈输出Key>
:: 从 CloudFormation 栈输出读取指定 Key 的 OutputValue 到目标变量；空值即报错。
:: -----------------------------------------------------------------------------
:read_output
set "__val="
for /f "usebackq delims=" %%v in (`aws cloudformation describe-stacks --stack-name %STACK_NAME% --query "Stacks[0].Outputs[?OutputKey=='%~2'].OutputValue" --output text`) do set "__val=%%v"
if "!__val!"=="" (
  echo [错误] 读取栈输出 %~2 失败（栈：%STACK_NAME%）。请确认 cdk deploy 已成功且输出存在。
  exit /b 1
)
if /i "!__val!"=="None" (
  echo [错误] 栈输出 %~2 为空（None）。请确认 cdk deploy 已成功且输出存在。
  exit /b 1
)
set "%~1=!__val!"
exit /b 0

:err
echo(
echo === 部署失败：上一步返回非零，已中止。请检查上方输出后重试。 ===
endlocal
exit /b 1
