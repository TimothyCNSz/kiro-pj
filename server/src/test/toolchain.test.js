import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { handler } from '../handler';
// Toolchain smoke test — confirms Vitest + fast-check are wired up and the
// backend Lambda entry point is importable/constructed. Real feature tests are
// added per slice; adapter + routing behavior is covered in `app.test.ts`.
describe('backend toolchain', () => {
    it('exposes a Lambda handler from the serverless-express adapter', () => {
        expect(typeof handler).toBe('function');
    });
    it('fast-check property runner is available', () => {
        fc.assert(fc.property(fc.integer(), fc.integer(), (a, b) => a + b === b + a), { numRuns: 50 });
    });
});
