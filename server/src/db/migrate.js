// Non-interactive migration runner for deploy scripts / CI.
//
// Applies the committed drizzle/ migrations to the database referenced by
// DATABASE_URL, then exits. It is idempotent — only migrations not yet
// recorded in the drizzle migrations table are applied — so it is safe to run
// on every deploy (设计「数据库迁移自动化」, 需求 19.3).
//
// Unlike `drizzle-kit migrate`, this runner depends only on runtime packages
// (drizzle-orm + postgres.js), so it can be bundled into the deploy artifact
// (dist/migrate.mjs, ESM) and executed where drizzle-kit (a devDependency) is
// not installed:
//
//   set DATABASE_URL=postgresql://app:<password>@<rds-endpoint>:5432/awsomeshop
//   node dist/migrate.mjs
//
// The committed drizzle/ folder must ship alongside the bundle (it sits one
// level up from dist/). Override the location with MIGRATIONS_DIR if needed.
//
// It uses a dedicated single connection with max: 1 and closes it before
// exiting so the process does not hang.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
/**
 * Absolute path to the committed migrations folder. Resolved relative to the
 * running module: from the bundled dist/migrate.mjs this points at
 * server/drizzle (../drizzle). An explicit MIGRATIONS_DIR env var overrides it.
 */
const migrationsFolder = process.env.MIGRATIONS_DIR ??
    resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle');
export async function runMigrations(databaseUrl) {
    // Dedicated migration connection: single connection, no pooling needed.
    const sql = postgres(databaseUrl, { max: 1 });
    try {
        const db = drizzle(sql);
        await migrate(db, { migrationsFolder });
    }
    finally {
        // Always release the connection so the runner process can exit.
        await sql.end({ timeout: 5 });
    }
}
async function main() {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        console.error('[migrate] DATABASE_URL is not set; aborting.');
        process.exit(1);
    }
    console.log(`[migrate] applying migrations from ${migrationsFolder} ...`);
    await runMigrations(databaseUrl);
    console.log('[migrate] migrations applied successfully.');
}
// Run only when executed directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    main().catch((err) => {
        console.error('[migrate] migration failed:', err);
        process.exit(1);
    });
}
