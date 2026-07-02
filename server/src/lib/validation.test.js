import { describe, it, expect } from 'vitest';
import { MIN_PASSWORD_LENGTH, validatePassword, parseEmailDomain, parseCompanyEmailDomains, validateEmailDomain, } from './validation';
describe('validatePassword (需求 1.1)', () => {
    it('accepts passwords with length >= 8 containing a letter and a digit', () => {
        expect(validatePassword('abcd1234')).toBe(true);
        expect(validatePassword('Password1')).toBe(true);
        expect(validatePassword('a1a1a1a1a1')).toBe(true);
    });
    it('rejects passwords shorter than the minimum length', () => {
        expect(MIN_PASSWORD_LENGTH).toBe(8);
        expect(validatePassword('abc123')).toBe(false); // length 6
        expect(validatePassword('aA1bB2')).toBe(false); // length 6
        expect(validatePassword('')).toBe(false);
    });
    it('rejects passwords missing a letter', () => {
        expect(validatePassword('12345678')).toBe(false);
    });
    it('rejects passwords missing a digit', () => {
        expect(validatePassword('abcdefgh')).toBe(false);
        expect(validatePassword('ABCDEFGH')).toBe(false);
    });
    it('accepts exactly 8 chars at the boundary', () => {
        expect(validatePassword('abcdefg1')).toBe(true);
    });
});
describe('parseEmailDomain', () => {
    it('extracts and lowercases the domain', () => {
        expect(parseEmailDomain('alice@Example.com')).toBe('example.com');
        expect(parseEmailDomain('  bob@CORP.Example.COM  ')).toBe('corp.example.com');
    });
    it('returns null for malformed emails', () => {
        expect(parseEmailDomain('no-at-sign')).toBeNull();
        expect(parseEmailDomain('two@@example.com')).toBeNull();
        expect(parseEmailDomain('a@b@example.com')).toBeNull();
        expect(parseEmailDomain('@example.com')).toBeNull();
        expect(parseEmailDomain('alice@')).toBeNull();
        expect(parseEmailDomain('')).toBeNull();
    });
});
describe('parseCompanyEmailDomains', () => {
    it('splits, trims, lowercases and drops empty entries', () => {
        expect(parseCompanyEmailDomains('example.com, Corp.Example.com ,,')).toEqual([
            'example.com',
            'corp.example.com',
        ]);
    });
    it('returns an empty array for empty/undefined input', () => {
        expect(parseCompanyEmailDomains(undefined)).toEqual([]);
        expect(parseCompanyEmailDomains(null)).toEqual([]);
        expect(parseCompanyEmailDomains('')).toEqual([]);
    });
});
describe('validateEmailDomain (需求 1.2, 1.7)', () => {
    const allowlist = ['example.com', 'corp.example.com'];
    it('accepts emails whose domain is in the allowlist (case-insensitive)', () => {
        expect(validateEmailDomain('alice@example.com', allowlist)).toBe(true);
        expect(validateEmailDomain('Bob@Example.COM', allowlist)).toBe(true);
        expect(validateEmailDomain('carol@corp.example.com', allowlist)).toBe(true);
    });
    it('rejects emails whose domain is not in the allowlist', () => {
        expect(validateEmailDomain('eve@gmail.com', allowlist)).toBe(false);
        expect(validateEmailDomain('mallory@notexample.com', allowlist)).toBe(false);
    });
    it('rejects malformed emails', () => {
        expect(validateEmailDomain('not-an-email', allowlist)).toBe(false);
        expect(validateEmailDomain('@example.com', allowlist)).toBe(false);
    });
    it('rejects everything when the allowlist is empty', () => {
        expect(validateEmailDomain('alice@example.com', [])).toBe(false);
    });
    it('reads the allowlist from COMPANY_EMAIL_DOMAINS when not injected', () => {
        const prev = process.env.COMPANY_EMAIL_DOMAINS;
        process.env.COMPANY_EMAIL_DOMAINS = 'example.com,corp.example.com';
        try {
            expect(validateEmailDomain('alice@example.com')).toBe(true);
            expect(validateEmailDomain('eve@gmail.com')).toBe(false);
        }
        finally {
            if (prev === undefined)
                delete process.env.COMPANY_EMAIL_DOMAINS;
            else
                process.env.COMPANY_EMAIL_DOMAINS = prev;
        }
    });
});
