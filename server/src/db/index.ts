// Barrel export for the data-access layer.
//
// Import the Drizzle schema, inferred row types, and the module-scoped database
// connection from `../db` (or `@/db`) rather than deep paths so the data layer
// surface stays stable across services.

export * from './schema'
export * from './client'
