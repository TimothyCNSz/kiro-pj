// Unit tests for password hashing utilities (口令仅存哈希, 需求 1.14)。
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password';
describe('hashPassword / verifyPassword', () => {
    it('produces a self-describing scrypt hash string that never contains the plaintext', () => {
        const hash = hashPassword('S3cretPass');
        expect(hash.startsWith('scrypt$')).toBe(true);
        expect(hash.split('$')).toHaveLength(6);
        expect(hash.includes('S3cretPass')).toBe(false);
    });
    it('verifies the correct password', () => {
        const hash = hashPassword('CorrectHorse9');
        expect(verifyPassword('CorrectHorse9', hash)).toBe(true);
    });
    it('rejects an incorrect password', () => {
        const hash = hashPassword('CorrectHorse9');
        expect(verifyPassword('wrong-password', hash)).toBe(false);
    });
    it('produces different hashes for the same password due to random salt', () => {
        const a = hashPassword('SamePass123');
        const b = hashPassword('SamePass123');
        expect(a).not.toBe(b);
        expect(verifyPassword('SamePass123', a)).toBe(true);
        expect(verifyPassword('SamePass123', b)).toBe(true);
    });
    it('returns false (never throws) for malformed stored hashes', () => {
        expect(verifyPassword('x', '')).toBe(false);
        expect(verifyPassword('x', 'not-a-hash')).toBe(false);
        expect(verifyPassword('x', 'bcrypt$1$2$3$4$5')).toBe(false);
        expect(verifyPassword('x', 'scrypt$16384$8$1$abcd$')).toBe(false);
    });
    it('is deterministic when the salt is injected', () => {
        const salt = 'a'.repeat(32);
        expect(hashPassword('pw', salt)).toBe(hashPassword('pw', salt));
    });
});
