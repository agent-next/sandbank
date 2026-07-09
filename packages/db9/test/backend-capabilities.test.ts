import { describe, expect, it } from 'vitest'
import {
  DB9_BACKEND_CAPABILITY_MATRIX,
  assertDb9BackendCapabilities,
  missingDb9BackendCapabilities,
  workspaceCapabilitiesToDb9BackendCapabilities,
} from '../src/backend-capabilities.js'

describe('DB9 backend capability matrix', () => {
  it('describes DB9 and Postgres compatibility for App Kernel requirements', () => {
    expect(DB9_BACKEND_CAPABILITY_MATRIX.map(item => item.name)).toContain('readonlySql')
    expect(DB9_BACKEND_CAPABILITY_MATRIX.map(item => item.name)).toContain('branch')
    expect(DB9_BACKEND_CAPABILITY_MATRIX.map(item => item.name)).toContain('scopedToken')
  })

  it('maps workspace capabilities into backend conformance booleans', () => {
    const actual = workspaceCapabilitiesToDb9BackendCapabilities({
      list: true,
      read: true,
      write: true,
      append: true,
      remove: true,
      move: false,
      stat: true,
      query: true,
      transaction: false,
      checkpoint: true,
      diff: true,
      rollback: true,
      watch: true,
      lock: false,
      log: true,
      sqlQuery: true,
      branch: false,
      fileAsTable: true,
      vectorSearch: false,
      functionRuntime: false,
      provider: { scopedToken: 'unsupported' },
    })

    expect(actual.readonlySql).toBe(true)
    expect(actual.branch).toBe(false)
    expect(actual.fileAsTable).toBe(true)
    expect(missingDb9BackendCapabilities(actual, ['readonlySql', 'branch'])).toEqual(['branch'])
    expect(() => assertDb9BackendCapabilities(actual, ['readonlySql', 'branch'])).toThrow('branch')
  })
})
