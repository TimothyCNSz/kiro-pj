import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ses from 'aws-cdk-lib/aws-ses';

/**
 * AWSomeShop 演示环境主 Stack。
 *
 * 组织约定：每类资源以独立的私有方法分块创建，并保留「扩展锚点」注释，
 * 便于后续任务在同一 Stack 上按资源追加，而不需要重构已有分块：
 *   - 19.1：前端私有 S3 桶（OAC）+ CloudFront 默认行为回源 + SPA 深链接回退
 *   - 19.2（本任务）：API Gateway（HTTP API）+ 单体 Lambda（无 VPC）+ CloudFront `/api/*` behavior
 *   - 19.3：RDS for PostgreSQL（公网可达 + 安全组限制来源 IP）
 *   - 19.4：上传桶（OAC 读 / 预签名 PUT 写 + CORS）+ CloudFront `/media/*` behavior
 *   - 19.5：SES 发件身份与 DKIM
 *
 * 演示级取舍：不含 WAF、自定义域名与证书（使用 CloudFront 默认域名）。
 */
export class AwsomeShopStack extends cdk.Stack {
  /** 前端静态资源私有桶（Vite 产物，经 CloudFront OAC 读取）。 */
  public readonly frontendBucket: s3.Bucket;

  /** 面向浏览器的唯一 CloudFront 分发。 */
  public readonly distribution: cloudfront.Distribution;

  /** 承载后端全部路由的单体 Lambda（Node.js 20.x，无 VPC）。 */
  public readonly backendFunction: lambda.Function;

  /** 反向代理到单体 Lambda 的 HTTP API（`{proxy+}` catch-all + proxy 集成）。 */
  public readonly httpApi: apigwv2.HttpApi;

  /** 承载公网可达 RDS 的最小 VPC（仅 public subnet，NAT 数量 0）。 */
  public readonly dbVpc: ec2.Vpc;

  /** 公网可达的 RDS for PostgreSQL 实例（演示级；主口令经 Secrets Manager 生成）。 */
  public readonly database: rds.DatabaseInstance;

  /** 用户上传图片的独立私有桶（Block Public Access 全开；OAC 读、预签名 PUT 写）。 */
  public readonly uploadBucket: s3.Bucket;

  /** SES 发件身份（演示级：默认域名身份并启用 Easy DKIM；发送验证邮件用）。 */
  public readonly sendingIdentity: ses.EmailIdentity;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── 19.1 前端托管：私有 S3 + CloudFront（OAC）+ SPA 深链接回退 ──────────────
    this.frontendBucket = this.createFrontendBucket();
    this.distribution = this.createDistribution(this.frontendBucket);

    // ── 扩展锚点 19.2：API Gateway（HTTP API）+ 单体 Lambda ────────────────────
    // 单体 Lambda（无 VPC，可直接公网出网）承载后端全部分层路由；HTTP API 以
    // `{proxy+}` catch-all + proxy 集成把请求原样转发给它；再在 19.1 建立的
    // distribution 上追加 `/api/*` behavior 指向 HTTP API 源（关闭缓存、透传 Authorization）。
    this.backendFunction = this.createBackendFunction();
    this.httpApi = this.createHttpApi(this.backendFunction);
    this.addApiBehavior(this.distribution, this.httpApi);

    // ── 扩展锚点 19.3：RDS for PostgreSQL（公网可达）─────────────────────────────
    // 演示取舍（网络简化，见设计）：RDS 置于 public subnet 且 publiclyAccessible，
    // Lambda（无 VPC）经公网直连，免 NAT Gateway / VPC Endpoint。生产不安全，
    // 仅为 demo 便利；至少以「安全组限制来源 IP + 强口令」作为 demo 级最低防护。
    this.dbVpc = this.createDatabaseVpc();
    this.database = this.createDatabase(this.dbVpc);

    // ── 扩展锚点 19.4：上传桶 + CloudFront `/media/*` behavior + CORS ───────────
    // 独立上传桶（与前端桶物理分离，见设计「存储桶设计」）：Block Public Access 全开，
    // 对象读取只经 CloudFront OAC（可缓存），直接写入仅限预签名 PUT；CORS 放行浏览器
    // 跨域 PUT（直传 S3）。同一分发新增 `/media/*` behavior 指向上传桶源（复用现有分发，
    // 避免多域名/证书/CORS 复杂度）。真实桶就绪后，把后端对上传桶的 PutObject 授权与
    // UPLOAD_BUCKET 环境变量对齐到真实桶（替换 19.2 的参数占位）。
    this.uploadBucket = this.createUploadBucket();
    this.grantUploadAccess(this.backendFunction, this.uploadBucket);
    this.addMediaBehavior(this.distribution, this.uploadBucket);

    // ── 扩展锚点 19.5：SES 发件身份与 DKIM ──────────────────────────────────────
    // 声明发件域名身份（默认演示占位 example.com）并启用 Easy DKIM（CDK 默认生成
    // DKIM 记录）；对后端 Lambda 授予向该身份发信的最小权限（ses:SendEmail /
    // ses:SendRawEmail）。发件地址（19.2 的 SES_FROM_ADDRESS 参数）须落在该域名之下。
    this.sendingIdentity = this.createSesIdentity();
    this.grantSendEmailAccess(this.backendFunction, this.sendingIdentity);

    // ── 栈输出（供后续 CLI 步骤与部署脚本消费）────────────────────────────────
    this.createOutputs();
  }

  /**
   * 前端静态资源桶：私有桶，Block Public Access 全开。
   * 不启用桶级静态网站托管——访问全部经由 CloudFront OAC，桶策略仅允许该分发读取。
   */
  private createFrontendBucket(): s3.Bucket {
    return new s3.Bucket(this, 'FrontendBucket', {
      // Block Public Access 全开：杜绝公网直连，仅经 CloudFront OAC 访问。
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // 演示级：销毁 Stack 时清空并删除桶，避免残留计费。生产应使用 RETAIN。
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
  }

  /**
   * CloudFront 分发：默认行为回源到前端私有桶（OAC）。
   * SPA 深链接回退：把源返回的 403/404 映射为 `/index.html` 且响应码 200，
   * 交给 Vue Router 处理刷新/深链接。
   */
  private createDistribution(frontendBucket: s3.Bucket): cloudfront.Distribution {
    // 使用 OAC（Origin Access Control）方式回源；该构造会自动创建 OAC 并
    // 为桶策略追加仅允许本分发读取的授权，无需再开放桶级公共读。
    const frontendOrigin = origins.S3BucketOrigin.withOriginAccessControl(frontendBucket);

    return new cloudfront.Distribution(this, 'Distribution', {
      comment: 'AWSomeShop 演示分发（默认回源前端 S3；后续追加 /api 与 /media behavior）',
      defaultRootObject: 'index.html',
      // 演示级：使用 CloudFront 默认域名，不配置自定义域名与证书、不挂 WAF。
      defaultBehavior: {
        origin: frontendOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },
      // SPA 深链接回退：403/404 → /index.html（200）。
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
    });
  }

  /**
   * 单体后端 Lambda：Node.js 20.x 运行时，无 VPC 配置（默认，可直接公网出网），
   * 引用 `server/` 经 esbuild 打包的产物目录（`npm run build:backend` → server/dist/handler.js）。
   *
   * 运行期配置全部经环境变量注入。敏感值（DATABASE_URL / JWT_SECRET）以 CfnParameter
   * 占位下发（演示级；生产应改用 SSM SecureString / Secrets Manager）；上传桶名等以参数占位，
   * 便于 19.4 上传桶就绪后由部署脚本覆盖真实值。
   */
  private createBackendFunction(): lambda.Function {
    // ── 运行期配置参数（演示级占位；部署时可 `--parameters` 覆盖真实值）──────────
    // 敏感值使用 noEcho，避免在控制台/事件里回显。
    const databaseUrl = new cdk.CfnParameter(this, 'DatabaseUrl', {
      type: 'String',
      noEcho: true,
      description: 'postgres.js 连接公网可达 RDS 的连接串（19.3 就绪后由部署脚本注入真实值）',
      default: 'postgres://app:change-me@localhost:5432/awsome_shop',
    });
    const jwtSecret = new cdk.CfnParameter(this, 'JwtSecret', {
      type: 'String',
      noEcho: true,
      description: '签发/校验 JWT 的密钥（演示级占位；生产改用 SSM SecureString）',
      default: 'change-me-in-production',
    });
    const sesFromAddress = new cdk.CfnParameter(this, 'SesFromAddress', {
      type: 'String',
      description: '验证邮件发件地址（19.5 SES 发件身份就绪后设为已验证地址）',
      default: 'no-reply@example.com',
    });
    const companyEmailDomains = new cdk.CfnParameter(this, 'CompanyEmailDomains', {
      type: 'String',
      description: '允许注册的公司邮箱域名白名单（逗号分隔）',
      default: 'example.com,corp.example.com',
    });
    const sessionIdleMinutes = new cdk.CfnParameter(this, 'SessionIdleMinutes', {
      type: 'Number',
      description: '会话空闲过期分钟数',
      default: 60,
    });
    const uploadBucketName = new cdk.CfnParameter(this, 'UploadBucketName', {
      type: 'String',
      description: '用户上传图片的 S3 桶名（19.4 上传桶就绪后设为真实桶名）',
      default: 'awsome-shop-uploads-dev',
    });
    const maxImageBytes = new cdk.CfnParameter(this, 'MaxImageBytes', {
      type: 'Number',
      description: '单张图片大小上限（字节，默认 5MB）',
      default: 5242880,
    });
    const maxProductImages = new cdk.CfnParameter(this, 'MaxProductImages', {
      type: 'Number',
      description: '单件商品可关联图片数量上限',
      default: 5,
    });

    const backendFunction = new lambda.Function(this, 'BackendFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      // 无 VPC 配置（默认）：可直接公网出网，直连公网可达 RDS 与 SES 公共端点，
      // 免 NAT Gateway / VPC Endpoint（演示取舍，见设计「演示取舍（网络简化）」）。
      handler: 'handler.handler',
      // 引用 server/ 经 esbuild 打包的产物目录（server/dist/handler.js 导出 handler）。
      // 部署前需先执行 `npm run build:backend`（见设计「后端部署自动化」）。
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'server', 'dist')),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      description: 'AWSomeShop 单体后端 Lambda（Express + serverless-express，经 HTTP API {proxy+} 代理）',
      environment: {
        DATABASE_URL: databaseUrl.valueAsString,
        JWT_SECRET: jwtSecret.valueAsString,
        SES_FROM_ADDRESS: sesFromAddress.valueAsString,
        COMPANY_EMAIL_DOMAINS: companyEmailDomains.valueAsString,
        SESSION_IDLE_MINUTES: cdk.Token.asString(sessionIdleMinutes.valueAsNumber),
        UPLOAD_BUCKET: uploadBucketName.valueAsString,
        // 图片公开访问基址 = 本分发域名（**不含** `/media`）。后端 `buildPublicUrl`
        // 会在此基址后追加 `/media/<objectKey>`（见 s3-presign.ts 与其单元测试），
        // 最终对外 URL 形如 `https://<domain>/media/<objectKey>`，命中 19.4 的
        // `/media/*` behavior。若此处再带上 `/media` 会导致 `/media/media/<key>` 重复前缀。
        MEDIA_BASE_URL: `https://${this.distribution.distributionDomainName}`,
        MAX_IMAGE_BYTES: cdk.Token.asString(maxImageBytes.valueAsNumber),
        MAX_PRODUCT_IMAGES: cdk.Token.asString(maxProductImages.valueAsNumber),
      },
    });

    // ── IAM：上传桶前缀的 s3:PutObject（用于签发预签名 PUT URL）────────────────────
    // 说明：真实上传桶由 19.4 创建。为避免对「尚不存在的真实桶」的占位授权与真实桶
    // 名（19.4 覆盖 UPLOAD_BUCKET）产生错配/冲突，这里不再基于 `UploadBucketName`
    // 参数值追加占位策略；改由 19.4 的 `grantUploadAccess` 对**真实桶资源**授予收敛到
    // `avatars/*` 与 `products/*` 前缀的 s3:PutObject（见 createUploadBucket 之后调用）。
    // 图片查看走 CloudFront 公开读，Lambda 无需 s3:GetObject。

    return backendFunction;
  }

  /**
   * HTTP API（API Gateway v2）：`{proxy+}` catch-all（ANY）+ 到单体 Lambda 的 proxy 集成。
   * 默认 `$default` stage 自动部署，请求原样透传给 Lambda，保留后端自有 `/api` 路由前缀。
   */
  private createHttpApi(backendFunction: lambda.Function): apigwv2.HttpApi {
    const integration = new apigwv2Integrations.HttpLambdaIntegration(
      'BackendIntegration',
      backendFunction,
    );

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      description: 'AWSomeShop HTTP API：{proxy+} catch-all 代理集成到单体后端 Lambda',
    });

    // catch-all：任意方法 + 任意路径 → 同一后端 Lambda（proxy 集成）。
    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
      integration,
    });

    return httpApi;
  }

  /**
   * 在 19.1 建立的分发上追加 `/api/*` behavior，指向 HTTP API 源。
   * - 关闭缓存（API 响应不可缓存）；
   * - 透传全部 viewer header（含 `Authorization`）、查询串与 cookie（AllViewerExceptHostHeader）；
   * - 允许全部 HTTP 方法（后端含 POST/PUT/PATCH/DELETE）。
   * HTTP API 默认 `$default` stage 服务于源根路径，故无需 originPath：
   * `/api/xxx` 经 CloudFront 转发后仍以 `/api/xxx` 抵达后端，命中其全局 `/api` 前缀。
   */
  private addApiBehavior(distribution: cloudfront.Distribution, httpApi: apigwv2.HttpApi): void {
    // apiEndpoint 形如 https://{apiId}.execute-api.{region}.amazonaws.com；
    // HttpOrigin 只需主机名，取 split('/') 的第 3 段（索引 2）。
    const apiDomainName = cdk.Fn.select(2, cdk.Fn.split('/', httpApi.apiEndpoint));

    distribution.addBehavior('/api/*', new origins.HttpOrigin(apiDomainName), {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      // 透传 Authorization 等全部 viewer header（Host 除外，交给源自行判定）+ 查询串 + cookie。
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    });
  }

  /**
   * 承载公网可达 RDS 的最小 VPC：仅 public subnet，NAT 数量设为 0（省成本）。
   * 演示取舍：RDS 需处于公有子网并 publiclyAccessible 才能被无 VPC 的 Lambda 经公网直连；
   * 无 NAT Gateway（本 Stack 无置于私有子网、需出网的资源），进一步降低网络成本与复杂度。
   */
  private createDatabaseVpc(): ec2.Vpc {
    return new ec2.Vpc(this, 'DbVpc', {
      // 演示级：两个 AZ 满足 RDS 子网组的最少 AZ 要求；无需更大网段。
      maxAzs: 2,
      // 省成本：不创建 NAT Gateway（无私有子网出网需求）。
      natGateways: 0,
      // 仅 public 子网：RDS 置于其中并公网可达（演示取舍）。
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });
  }

  /**
   * 公网可达的 RDS for PostgreSQL 实例（演示级）。
   *
   * 安全：`publiclyAccessible: true` + 置于 public subnet 使其可被无 VPC 的 Lambda
   * 经公网直连；安全组仅放行受限来源 IP（`AllowedDbCidr` 参数）到 PostgreSQL 端口 5432。
   * **演示取舍**：公网可达在生产中不安全，仅为 demo 便利；生产应改回私有子网 + 不公网暴露。
   *
   * 强口令：主口令由 Secrets Manager 生成并托管（`Credentials.fromGeneratedSecret`），
   * 不在模板/代码中出现明文；部署脚本可据 secret 组装 `DATABASE_URL` 注入 19.2 的 Lambda 参数。
   *
   * 演示级取舍：单可用区、最小存储、`removalPolicy: DESTROY`、关闭删除保护与备份保留。
   */
  private createDatabase(vpc: ec2.Vpc): rds.DatabaseInstance {
    // 受限来源 CIDR：默认占位 127.0.0.1/32（不放行任何真实来源）。
    // 部署时务必以 `--parameters AllowedDbCidr=<你的出口IP>/32` 收敛到受信来源，
    // 例如运行迁移/种子脚本的机器出口 IP。演示便利：可临时放宽，但生产不可如此。
    const allowedDbCidr = new cdk.CfnParameter(this, 'AllowedDbCidr', {
      type: 'String',
      description:
        '允许连接 RDS(5432) 的来源 CIDR（演示级最低防护）。默认 127.0.0.1/32 为占位，' +
        '部署时请收敛为运行迁移/种子的机器出口 IP，如 203.0.113.10/32。',
      default: '127.0.0.1/32',
    });

    // 安全组：默认拒绝入站，仅显式放行受限来源 IP → PostgreSQL 5432。
    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc,
      description: 'AWSomeShop RDS 安全组：仅放行受限来源 IP 到 PostgreSQL 5432（演示级最低防护）',
      allowAllOutbound: true,
    });
    dbSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(allowedDbCidr.valueAsString),
      ec2.Port.tcp(5432),
      '受限来源 IP → PostgreSQL 5432（演示取舍：公网可达仅为 demo 便利，生产不安全）',
    );

    const database = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      vpc,
      // 置于 public subnet + 公网可达（演示取舍）。
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      publiclyAccessible: true,
      securityGroups: [dbSecurityGroup],
      // 演示级实例类型：t3.micro（Burstable，低成本）。
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.MICRO),
      // 强口令：由 Secrets Manager 生成并托管主口令（用户名 app），无明文落库/落模板。
      credentials: rds.Credentials.fromGeneratedSecret('app'),
      // 初始数据库名，供部署脚本组装 DATABASE_URL。
      databaseName: 'awsome_shop',
      // 演示级：最小存储、单可用区、关闭删除保护与备份保留。
      allocatedStorage: 20,
      multiAz: false,
      deletionProtection: false,
      backupRetention: cdk.Duration.days(0),
      // 演示级：销毁 Stack 时一并删除实例，避免残留计费。生产应使用 RETAIN/SNAPSHOT。
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── RDS 相关输出：供部署脚本组装 DATABASE_URL（endpoint + secret 中的口令）──────
    new cdk.CfnOutput(this, 'DbEndpointAddress', {
      value: database.dbInstanceEndpointAddress,
      description: 'RDS PostgreSQL 端点地址（供部署脚本组装 DATABASE_URL 的 host）',
    });
    new cdk.CfnOutput(this, 'DbEndpointPort', {
      value: database.dbInstanceEndpointPort,
      description: 'RDS PostgreSQL 端点端口（默认 5432）',
    });
    if (database.secret) {
      new cdk.CfnOutput(this, 'DbSecretArn', {
        value: database.secret.secretArn,
        description:
          'RDS 主口令 Secret 的 ARN（含 username/password/host/port/dbname，供部署脚本组装 DATABASE_URL）',
      });
    }

    return database;
  }

  /**
   * 用户上传图片的独立上传桶（与前端桶物理分离，见设计「存储桶设计」）。
   *
   * 安全模型（对齐设计「上传桶经 CloudFront 公开读、桶本身 OAC/受控写入」）：
   * - Block Public Access 全开、不开放桶级公共读：对象读取只经 CloudFront OAC；
   * - 直接对桶的写入仅限后端签发的预签名 PUT（见 grantUploadAccess 的最小权限授权）；
   * - S3 托管加密 + enforceSSL（强制 HTTPS 传输）。
   *
   * CORS（需求 22.6/22.7）：客户端在浏览器内用预签名 URL **直传** S3（后端不中转字节），
   * 属跨域 PUT，必须放行来源与方法。演示级允许来源默认 `*`（经 `UploadCorsAllowedOrigin`
   * 参数可覆盖）——生产应收敛为前端实际域名（如 `https://<distributionDomainName>` 或
   * 自定义域名）。允许方法含 PUT（直传）与 GET/HEAD（诊断/直读），允许全部请求头，
   * 并暴露 `ETag` 以便客户端校验上传结果。
   *
   * 演示级取舍：removalPolicy DESTROY + autoDeleteObjects，销毁 Stack 时清空并删除桶，
   * 避免残留计费。生产应使用 RETAIN。
   */
  private createUploadBucket(): s3.Bucket {
    // 允许跨域直传的来源：演示级默认 `*`（放行任意来源，便于 demo）。
    // 生产务必收敛为前端实际域名，例如以 `--parameters UploadCorsAllowedOrigin=https://<你的域名>` 覆盖。
    const allowedOrigin = new cdk.CfnParameter(this, 'UploadCorsAllowedOrigin', {
      type: 'String',
      description:
        '上传桶 CORS 允许的浏览器来源（预签名 PUT 直传）。演示级默认 * 放行任意来源；' +
        '生产请收敛为前端实际域名，如 https://<distributionDomainName> 或自定义域名。',
      default: '*',
    });

    return new s3.Bucket(this, 'UploadBucket', {
      // Block Public Access 全开：杜绝公网直连，读取仅经 CloudFront OAC。
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // 演示级：销毁 Stack 时清空并删除桶，避免残留计费。生产应使用 RETAIN。
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      // CORS：放行浏览器跨域直传（PUT）与直读（GET/HEAD），暴露 ETag 供客户端校验。
      cors: [
        {
          allowedMethods: [
            s3.HttpMethods.PUT,
            s3.HttpMethods.GET,
            s3.HttpMethods.HEAD,
          ],
          allowedOrigins: [allowedOrigin.valueAsString],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
    });
  }

  /**
   * 将后端 Lambda 对上传桶的写权限与运行期配置对齐到**真实桶**（替换 19.2 的参数占位）：
   * - 覆盖 `UPLOAD_BUCKET` 环境变量为真实桶名（`addEnvironment` 覆盖 19.2 的参数默认值），
   *   使 S3 预签名服务针对真实桶签发；
   * - 以**最小权限**授予 `s3:PutObject`，收敛到 `avatars/*` 与 `products/*` 两个前缀
   *   （对齐设计的 objectKey 模式）。图片查看走 CloudFront 公开读，Lambda 无需 s3:GetObject。
   */
  private grantUploadAccess(backendFunction: lambda.Function, uploadBucket: s3.Bucket): void {
    // 覆盖 19.2 以 `UploadBucketName` 参数占位的 UPLOAD_BUCKET，指向真实桶名。
    backendFunction.addEnvironment('UPLOAD_BUCKET', uploadBucket.bucketName);

    // 最小权限：仅 avatars/* 与 products/* 前缀的 PutObject（真实桶 ARN 由 CDK 解析）。
    backendFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'PutUploadObjectsScopedToPrefixes',
        effect: iam.Effect.ALLOW,
        actions: ['s3:PutObject'],
        resources: [
          uploadBucket.arnForObjects('avatars/*'),
          uploadBucket.arnForObjects('products/*'),
        ],
      }),
    );
  }

  /**
   * 在 19.1 建立的分发上追加 `/media/*` behavior，经 OAC 读取上传桶。
   * - OAC 回源（`S3BucketOrigin.withOriginAccessControl`）：自动创建 OAC 并为上传桶策略
   *   追加仅允许本分发读取的授权，无需开放桶级公共读；
   * - 图片非敏感、可公开缓存（需求 22.10）：启用缓存优化策略（CACHING_OPTIMIZED）与压缩；
   * - 只读：仅放行 GET/HEAD（写入只经预签名 PUT 直传，不经 CloudFront）。
   * 公开访问 URL 形如 `https://<distributionDomainName>/media/<objectKey>`（对齐设计）。
   */
  private addMediaBehavior(distribution: cloudfront.Distribution, uploadBucket: s3.Bucket): void {
    const mediaOrigin = origins.S3BucketOrigin.withOriginAccessControl(uploadBucket);

    // CloudFront 的路径模式（`/media/*`）只用于**选择** behavior，并不会剥离前缀：
    // 缺省情况下 viewer 路径会被原样转发给源。上传桶内的对象 key 形如
    // `avatars/...`、`products/...`（无 `media/` 前缀），故需在 viewer-request 阶段
    // 用 CloudFront Function 去掉开头的 `/media`，把 `/media/avatars/x.jpg` 改写为
    // `/avatars/x.jpg`，S3 侧再去掉前导斜杠得到对象 key `avatars/x.jpg`，与后端签发/
    // 存储的 key 对齐（否则会去请求不存在的 `media/avatars/...` 而 404）。
    const stripMediaPrefix = new cloudfront.Function(this, 'StripMediaPrefixFn', {
      comment: '将 /media/<objectKey> 改写为 /<objectKey>，与上传桶对象 key 对齐',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        [
          'function handler(event) {',
          '  var request = event.request;',
          "  request.uri = request.uri.replace(/^\\/media/, '');",
          "  if (request.uri === '') { request.uri = '/'; }",
          '  return request;',
          '}',
        ].join('\n'),
      ),
    });

    distribution.addBehavior('/media/*', mediaOrigin, {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      compress: true,
      functionAssociations: [
        {
          function: stripMediaPrefix,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        },
      ],
    });
  }

  /**
   * SES 发件身份与 Easy DKIM（演示级）。
   *
   * 身份类型（演示以**域名身份**为主）：
   * - 用 `ses.EmailIdentity` + `ses.Identity.domain(<域名>)` 声明**域名身份**。CDK 对域名身份
   *   默认启用 **Easy DKIM**（自动生成 3 条 DKIM CNAME 记录），提升投递率并满足合规
   *   （对齐设计「发送身份与合规：公司域名并配置 DKIM」）。
   * - **DNS 记录添加**：本演示未接管 Route53 托管区（`example.com` 占位多半不在本账号 Route53），
   *   故 CDK 只创建身份、生成 DKIM 记录值，**不会自动写入 DNS**。部署后需到 SES 控制台查看
   *   生成的 3 条 DKIM CNAME 记录，手动添加到该域名的权威 DNS，等待 SES 校验通过（状态变
   *   为 verified）后方可发信。若日后把域名托管迁至本账号 Route53，可改为
   *   `ses.EmailIdentity` 传入 `hostedZone`，令 CDK 自动写入 DKIM 记录（免手动）。
   *
   * 备选：**邮箱地址身份**。若无法控制整个域名的 DNS，可改用地址身份
   * `ses.Identity.email('no-reply@example.com')`——SES 会向该地址发送一封验证邮件，
   * 点击确认即完成验证（无 DKIM）。演示联调、sandbox 阶段常用此法（见下方注释示例）。
   *
   * sandbox → production：新账号处于 SES sandbox，仅能发往**已验证收件地址**；
   * 需向 AWS 申请迁出 sandbox 后，才能向任意公司邮箱发送验证邮件（对齐设计合规要点）。
   */
  private createSesIdentity(): ses.EmailIdentity {
    // 发件域名（演示占位）：部署时以 `--parameters SesSendingDomain=<你的真实已验证域名>` 覆盖，
    // 并确保 19.2 的 `SesFromAddress` 发件地址落在该域名之下（如 no-reply@<该域名>），二者保持一致。
    const sendingDomain = new cdk.CfnParameter(this, 'SesSendingDomain', {
      type: 'String',
      description:
        'SES 发件域名身份（演示占位 example.com；部署时替换为真实、可控 DNS 的域名）。' +
        '需与 19.2 的 SesFromAddress 发件地址域名一致，并在 DNS 添加 SES 生成的 DKIM CNAME 记录。',
      default: 'example.com',
    });

    // 域名身份 + Easy DKIM（CDK 对域名身份默认开启 DKIM 记录生成）。
    const identity = new ses.EmailIdentity(this, 'SendingIdentity', {
      identity: ses.Identity.domain(sendingDomain.valueAsString),
      // Easy DKIM 默认启用；此处显式声明以示意（RSA_2048_BIT 为默认强度）。
      dkimSigning: true,
    });

    // 备选（邮箱地址身份，演示/联调用）——无需控制整域 DNS，SES 发确认邮件到该地址即可：
    //   new ses.EmailIdentity(this, 'SendingIdentity', {
    //     identity: ses.Identity.email(/* 19.2 的 */ sesFromAddress.valueAsString),
    //   });
    // 若域名已托管在本账号 Route53，可让 CDK 自动写入 DKIM 记录（免手动）：
    //   identity: ses.Identity.publicHostedZone(myHostedZone),

    return identity;
  }

  /**
   * 授予后端 Lambda 向上述发件身份发送验证邮件的**最小权限**：
   * `ses:SendEmail` / `ses:SendRawEmail`，资源收敛到该发件身份的 ARN
   * （`arn:aws:ses:<region>:<account>:identity/<域名或地址>`），而非 `*`。
   * 后端经 SES 发送注册验证邮件（需求 1.4）；无 VPC 的 Lambda 可直连 SES 公共端点。
   */
  private grantSendEmailAccess(backendFunction: lambda.Function, sendingIdentity: ses.EmailIdentity): void {
    const identityArn = this.formatArn({
      service: 'ses',
      resource: 'identity',
      resourceName: sendingIdentity.emailIdentityName,
    });

    backendFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'SendVerificationEmailsViaSes',
        effect: iam.Effect.ALLOW,
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: [identityArn],
      }),
    );
  }

  /** 栈输出：暴露桶名与分发信息，供前端发布（aws s3 sync / invalidation）与脚本消费。 */
  private createOutputs(): void {    new cdk.CfnOutput(this, 'FrontendBucketName', {
      value: this.frontendBucket.bucketName,
      description: '前端静态资源 S3 桶名（供 aws s3 sync 使用）',
    });
    new cdk.CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
      description: 'CloudFront 分发 ID（供 create-invalidation 使用）',
    });
    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
      description: 'CloudFront 默认域名（前端访问入口）',
    });
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: this.httpApi.apiEndpoint,
      description: 'HTTP API 默认端点（诊断用；浏览器统一经 CloudFront /api/* 访问）',
    });
    new cdk.CfnOutput(this, 'BackendFunctionName', {
      value: this.backendFunction.functionName,
      description: '单体后端 Lambda 函数名（供日志排查 / 手动调用）',
    });
    new cdk.CfnOutput(this, 'UploadBucketNameOutput', {
      value: this.uploadBucket.bucketName,
      description: '用户上传图片的 S3 桶名（真实桶；已作为 UPLOAD_BUCKET 注入后端 Lambda）',
    });
    new cdk.CfnOutput(this, 'SesSendingIdentityName', {
      value: this.sendingIdentity.emailIdentityName,
      description:
        'SES 发件身份名（域名/地址）；部署后需在 SES 控制台查看生成的 DKIM CNAME 记录并添加到该域名 DNS，' +
        '待身份状态 verified 后方可发信。发件地址（SES_FROM_ADDRESS）须落在此身份域名之下。',
    });
  }
}
