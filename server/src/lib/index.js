// Barrel export for shared lib types & contracts.
//
// Import shared contracts from `../lib` (or `@/lib`) rather than deep paths so
// the shared-type surface stays stable across the backend.
export * from './api';
export * from './domain';
export * from './errors';
export * from './validation';
