import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const html = readFileSync(resolve(__dirname, '../src/ui/console.html'), 'utf8')
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'))

describe('console.html (MCP Apps view)', () => {
  it('is a single self-contained HTML document under 40 KB', () => {
    expect(html.trimStart().toLowerCase().startsWith('<!doctype html>')).toBe(true)
    expect(Buffer.byteLength(html)).toBeLessThan(40 * 1024)
    expect(html.match(/<html[\s>]/g)).toHaveLength(1)
    expect(html.match(/<script[\s>]/g)).toHaveLength(1)
    expect(html.match(/<style[\s>]/g)).toHaveLength(1)
    expect(html.match(/<\/html>/g)).toHaveLength(1)
    expect(html).toMatch(/prefers-color-scheme:\s*dark/)
    expect(script).toContain('document.documentElement.lang')
  })

  it('loads nothing external: no src/href/url()/import to a remote origin', () => {
    expect(html).not.toMatch(/\b(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//i)
    expect(html).not.toMatch(/url\(\s*["']?\s*(?:https?:)?\/\//i)
    expect(html).not.toMatch(/@import/i)
    expect(html).not.toMatch(/<(?:link|img|iframe|embed|object)\b/i)
    expect(html).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|\bimport\s*\(/)
    // the only remote URL pattern is the sbx preview host
    const remote = html.match(/https?:\\?\/\\?\/[^\s"'`)]*/g) ?? []
    for (const u of remote) expect(u).toMatch(/^https:\\\/\\\/\[a-z0-9-\]\+/)
    expect(html).toContain('sbx\\.agent-next\\.com')
  })

  it('handles both host notifications and the bridge handshake', () => {
    expect(script).toContain('ui/notifications/tool-result')
    expect(script).toContain('ui/notifications/tool-input')
    expect(script).toContain('ui/initialize')
    expect(script).toContain('ui/update-model-context')
    expect(script).toContain('ui/message')
    expect(script).toContain('tools/call')
    expect(script).toContain('structuredContent')
    expect(script).toContain('window.parent.postMessage')
  })

  it('calls every data tool in the contract', () => {
    for (const name of [
      'providers_list', 'sandbox_create', 'sandbox_list', 'sandbox_exec', 'port_expose', 'sandbox_destroy',
    ]) {
      expect(script).toContain(`'${name}'`)
    }
  })

  it('never writes untrusted data as markup', () => {
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/)
    expect(script).not.toMatch(/\beval\s*\(|new Function/)
    expect(script).not.toMatch(/\b(?:window\.)?(?:confirm|alert|prompt)\s*\(/)
    expect(script).toContain('textContent')
  })

  it('gates the inline preview iframe on the sbx host pattern and has a two-step destroy', () => {
    expect(script).toMatch(/PREVIEW_RE\.test\(/)
    expect(script).toContain('confirmKey')
    expect(script).toContain('disabled')
  })

  it('embedded script parses', () => {
    expect(() => new Function(script)).not.toThrow()
  })
})
