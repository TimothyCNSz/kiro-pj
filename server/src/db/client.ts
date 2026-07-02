// Database connection module (Lambda 公网直连 RDS).
//
// The postgres.js client and the Drizzle instance are created ONCE and cached
// at module scope, so "warm" Lambda invocations that reuse the same execution
// environment reuse the same connection pool instead of reconnecting on every
// request (see design "数据库连接策略（Lambda 公网直连 RDS）"):
//
//   - postgres.js client: `postgres(DATABASE_URL, { max: 1 })`
//     A very small per-container pool (max = 1) is sufficient because a single
//     Lambda execution environment only handles one request at a time.
//   - Drizzle: `drizzle(sql, { schema })` for typed queries bound to the schema.
//
// Initialization is lazy/memoized rather than eager: merely importing this
// module does NOT open a connection or require `DATABASE_URL`, so unit tests
// that import code depending on the schema/types don't fail without a live
// database. The connection is only established on first actual use (getDb()).
//
// Requirements: 19.3.

import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres, { type Sql } from 'postgres'

import * as schema from './schema'

/** Typed Drizzle database bound to the full AWSomeShop schema. */
export type Database = PostgresJsDatabase<typeof schema>

// Module-scoped singletons: reused across warm Lambda invocations.
let sqlClient: Sql | undefined
let dbInstance: Database | undefined

/**
 * Small per-container connection pool. One execution environment serves a
 * single request at a time, so a tiny pool avoids exhausting RDS connections
 * across concurrent warm containers.
 */
const POOL_MAX = 1

function resolveDatabaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. The database connection cannot be initialized. ' +
        'Set DATABASE_URL (see .env.example) before performing database operations.',
    )
  }
  return url
}

/**
 * Lazily create (and memoize) the module-scoped postgres.js client.
 * Warm invocations reuse the same client/pool.
 */
export function getSql(): Sql {
  if (!sqlClient) {
    sqlClient = postgres(resolveDatabaseUrl(), { max: POOL_MAX })
  }
  return sqlClient
}

/**
 * Lazily create (and memoize) the module-scoped Drizzle instance bound to the
 * schema. This is the primary entry point for typed queries across services.
 */
export function getDb(): Database {
  if (!dbInstance) {
    dbInstance = drizzle(getSql(), { schema })
  }
  return dbInstance
}

/**
 * Convenience accessor: a Drizzle instance that initializes the connection on
 * first property access. Prefer this in service code for ergonomic typed
 * queries (e.g. `db.select()...`). Importing it does not open a connection.
 */
export const db: Database = new Proxy({} as Database, {
  get(_target, prop, receiver) {
    const instance = getDb()
    const value = Reflect.get(instance as object, prop, receiver)
    return typeof value === 'function' ? value.bind(instance) : value
  },
})

/**
 * Close the module-scoped connection and reset the cached singletons.
 * Primarily used by tests and graceful-shutdown paths; production Lambda
 * relies on execution-environment reuse and does not close between requests.
 */
export async function closeDb(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 })
    sqlClient = undefined
    dbInstance = undefined
  }
}
