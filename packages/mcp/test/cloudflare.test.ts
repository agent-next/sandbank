import { describe, expect, it } from 'vitest'
import { defaultRegistry } from '../src/registry.js'

describe('cloudflare provider registration', () => {
  it('is listed but unconfigured without env', () => {
    expect(defaultRegistry({}).cloudflare?.configured).toBe(false)
    expect(defaultRegistry({ SANDBANK_CF_BRIDGE_URL: 'https://b' }).cloudflare?.configured).toBe(false)
    expect(defaultRegistry({ SANDBANK_CF_BRIDGE_URL: '${X}', SANDBANK_CF_BRIDGE_TOKEN: 't' }).cloudflare?.configured).toBe(false)
  })
  it('is configured with URL and token, and exposes capabilities', () => {
    const r = defaultRegistry({ SANDBANK_CF_BRIDGE_URL: 'https://b', SANDBANK_CF_BRIDGE_TOKEN: 't' })
    expect(r.cloudflare?.configured).toBe(true)
    expect(r.cloudflare?.get().name).toBe('cloudflare')
  })
})
