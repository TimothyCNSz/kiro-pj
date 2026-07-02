// Unit tests for the database connection module (Requirements: 19.3).
//
// These tests verify import-safety and lazy initialization: importing the
// module and reusing the module-scoped singleton must NOT require a live
// database or DATABASE_URL, while accessing the connection without config
// fails clearly.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getSql } from './client'

describe('db/client', () => {
  const originalUrl = process.env.DATABASE_URL

  beforeEach(() => {
    delete process.env.DATABASE_URL
  })

  afterEach(() => {
    if (originalUrl === undefined) {
      delete process.env.DATABASE_URL
    } else {
      process.env.DATABASE_URL = originalUrl
    }
  })

  it('does not require DATABASE_URL just to import the module', () => {
    // The import at the top of this file already succeeded without DATABASE_URL.
    expect(typeof getDb).toBe('function')
    expect(typeof getSql).toBe('function')
  })

  it('throws a clear error when initializing without DATABASE_URL', () => {
    expect(() => getSql()).toThrowError(/DATABASE_URL is not set/)
  })

  it('reuses the same module-scoped client/db across calls (warm reuse)', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/awsome_shop_test'

    const sqlA = getSql()
    const sqlB = getSql()
    expect(sqlA).toBe(sqlB)

    const dbA = getDb()
    const dbB = getDb()
    expect(dbA).toBe(dbB)
  })
})
