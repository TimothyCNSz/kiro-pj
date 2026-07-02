import { defineConfig } from 'vitest/config';
export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['src/**/*.test.ts'],
        // Property-based tests (fast-check) can run many iterations; allow generous timeout.
        testTimeout: 30_000,
    },
});
