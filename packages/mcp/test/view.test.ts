import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RENDER_VIEW_EXAMPLE } from '../../openui-view/src/index.js'

const chrome = ['google-chrome', 'chromium', 'chrome'].find((b) => spawnSync('which', [b]).status === 0)

describe.skipIf(!chrome)('bundled view.html in headless chrome', () => {
  it('renders RENDER_VIEW_EXAMPLE posted as a tool-result', () => {
    const pkg = resolve(__dirname, '../../openui-view')
    execFileSync('node', ['build.mjs'], { cwd: pkg, stdio: 'pipe' })
    const view = readFileSync(resolve(pkg, 'dist/view.html'), 'utf8')
    const j = (v: unknown) => JSON.stringify(v).replaceAll('<', '\\u003c')
    const host = `<!doctype html><body><iframe id="f"></iframe><pre id="out"></pre><script>
const f = document.getElementById('f');
f.srcdoc = ${j(view)};
f.addEventListener('load', () => {
  f.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result',
    params: { structuredContent: { openui: ${j(RENDER_VIEW_EXAMPLE)} } } }, '*');
  setTimeout(() => { document.getElementById('out').textContent = 'RENDERED::' + f.contentDocument.body.innerText; }, 500);
});
</script></body>`
    const dir = mkdtempSync(join(tmpdir(), 'view-test-'))
    try {
      const file = join(dir, 'host.html')
      writeFileSync(file, host)
      const dom = execFileSync(
        chrome!,
        ['--headless=new', '--no-sandbox', '--disable-gpu', '--virtual-time-budget=5000', '--dump-dom', `file://${file}`],
        { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
      )
      expect(dom).toContain('RENDERED::')
      for (const t of ['Build result', 'Duration ms', '1240', 'compiled 12 files', 'b.ts', 'Re-run']) expect(dom).toContain(t)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
