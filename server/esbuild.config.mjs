// esbuild bundling for the single monolithic backend Lambda.
// Produces a tree-shaken, minified CommonJS bundle at dist/handler.js.
// The AWS SDK v3 is available in the Lambda Node.js runtime, so it is marked
// external to keep the bundle small and cold starts light.
import { build } from 'esbuild'

const isWatch = process.argv.includes('--watch')

/** Shared bundling options for the Node/Lambda artifacts. */
const shared = {
  bundle: true,
  minify: true,
  sourcemap: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // AWS SDK v3 modules are provided by the Lambda runtime; do not bundle them.
  external: ['@aws-sdk/*'],
  logLevel: 'info',
}

/** @type {import('esbuild').BuildOptions} */
const handlerOptions = {
  ...shared,
  entryPoints: ['src/handler.ts'],
  outfile: 'dist/handler.js',
}

// Standalone non-interactive migration runner for deploy scripts / CI.
// Bundles drizzle-orm + postgres.js so it runs without drizzle-kit installed.
/** @type {import('esbuild').BuildOptions} */
const migrateOptions = {
  ...shared,
  format: 'esm',
  entryPoints: ['src/db/migrate.ts'],
  outfile: 'dist/migrate.mjs',
}

// Standalone non-interactive seed runner (初始管理员种子, 幂等).
// Bundles drizzle-orm + postgres.js so it runs where devDependencies are absent.
/** @type {import('esbuild').BuildOptions} */
const seedOptions = {
  ...shared,
  format: 'esm',
  entryPoints: ['src/db/seed.ts'],
  outfile: 'dist/seed.mjs',
}

// Standalone non-interactive demo seed runner (演示数据种子, 幂等, 仅演示环境).
// Bundles drizzle-orm + postgres.js so it runs where devDependencies are absent.
/** @type {import('esbuild').BuildOptions} */
const seedDemoOptions = {
  ...shared,
  format: 'esm',
  entryPoints: ['src/db/seed-demo.ts'],
  outfile: 'dist/seed-demo.mjs',
}

// Local development HTTP server (本地验证用，非部署产物). Runs the same Express
// app as a plain Node server instead of behind API Gateway/Lambda.
// Built as CommonJS with a .cjs extension so Node treats it as CJS even though
// package.json sets "type":"module" (Express relies on dynamic require, which
// an ESM bundle cannot support).
/** @type {import('esbuild').BuildOptions} */
const localOptions = {
  ...shared,
  entryPoints: ['src/local.ts'],
  outfile: 'dist/local.cjs',
}

if (isWatch) {
  const esbuild = await import('esbuild')
  const handlerCtx = await esbuild.context(handlerOptions)
  const migrateCtx = await esbuild.context(migrateOptions)
  const seedCtx = await esbuild.context(seedOptions)
  const seedDemoCtx = await esbuild.context(seedDemoOptions)
  const localCtx = await esbuild.context(localOptions)
  await Promise.all([
    handlerCtx.watch(),
    migrateCtx.watch(),
    seedCtx.watch(),
    seedDemoCtx.watch(),
    localCtx.watch(),
  ])
  console.log('esbuild: watching for changes...')
} else {
  await Promise.all([
    build(handlerOptions),
    build(migrateOptions),
    build(seedOptions),
    build(seedDemoOptions),
    build(localOptions),
  ])
  console.log(
    'esbuild: bundles written to dist/handler.js, dist/migrate.mjs, dist/seed.mjs, dist/seed-demo.mjs and dist/local.cjs',
  )
}
