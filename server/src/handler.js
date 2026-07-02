// Backend entry point for the single monolithic AWS Lambda.
//
// The serverless-express adapter maps API Gateway HTTP API `{proxy+}` proxy
// events onto the Express app defined in `./app`, so the backend keeps its own
// routing (global `/api` prefix + feature routers) unchanged under the gateway
// catch-all. The app is created once at module scope so warm invocations reuse
// the same instance (and, later, the module-scoped DB connection pool).
//
// Design ref: "单体 Lambda 与冷启动" / Lambda 适配器.
// Requirements: 19.3.
import serverlessExpress from '@codegenie/serverless-express';
import { createApp } from './app';
const app = createApp();
/** AWS Lambda handler wired to API Gateway `{proxy+}` proxy integration. */
export const handler = serverlessExpress({ app });
