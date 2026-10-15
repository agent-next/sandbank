import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const res = await build({
  entryPoints: ['src/view.tsx'],
  bundle: true,
  minify: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
})
const js = res.outputFiles[0].text.replaceAll('</script', '<\\/script')
const css = readFileSync('src/view.css', 'utf8')
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sandbank view</title><style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`
mkdirSync('dist', { recursive: true })
writeFileSync('dist/view.html', html)
console.log(`dist/view.html ${html.length} bytes`)

// Node entry (catalog prompt + library) for the MCP server.
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  outfile: 'dist/index.js',
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  banner: { js: "import { createRequire } from 'node:module';const require = createRequire(import.meta.url);" },
  logLevel: 'error',
})
writeFileSync(
  'dist/index.d.ts',
  'export declare const RENDER_VIEW_EXAMPLE: string\nexport declare function getCatalogPrompt(): string\n',
)
