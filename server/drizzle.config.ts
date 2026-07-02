// drizzle-kit configuration for AWSomeShop (PostgreSQL / postgres.js).
//
// Migrations are generated from the TypeScript schema (src/db/schema.ts) via
// `drizzle-kit generate` and committed to the repository (drizzle/). Deploy
// scripts apply them non-interactively with `drizzle-kit migrate`, which only
// runs migrations not yet applied — idempotent and safe to re-run
// (设计「数据库迁移自动化」, 需求 19.3).
//
// `drizzle-kit generate` works purely from the schema and does NOT need a live
// database; only `drizzle-kit migrate` connects using DATABASE_URL.

import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  // Only consumed by `drizzle-kit migrate`/`push`; generation ignores it.
  // Left as a harmless placeholder so `generate` runs without DATABASE_URL set;
  // deploy scripts export the real RDS connection string before migrating.
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/awsomeshop',
  },
  // Emit richer, deterministic SQL and verbose logging for review/CI.
  verbose: true,
  strict: true,
})
