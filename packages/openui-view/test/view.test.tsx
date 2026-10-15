import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { Renderer } from '@openuidev/react-lang'
import { beforeAll, describe, expect, it } from 'vitest'
import { getCatalogPrompt, library, RENDER_VIEW_EXAMPLE } from '../src/index.js'

const pkg = resolve(__dirname, '..')

describe('openui-view catalog', () => {
  it('builds a library with the full component set', () => {
    expect(Object.keys(library.components).sort()).toEqual(
      ['ActionButton', 'BarChart', 'Card', 'LogBlock', 'Link', 'Stack', 'Stat', 'Table'].sort(),
    )
  })

  it('generates a prompt derived from the schemas', () => {
    const p = getCatalogPrompt()
    for (const n of ['Stack', 'Card', 'Stat', 'Table', 'LogBlock', 'BarChart', 'Link', 'ActionButton']) {
      expect(p).toContain(n)
    }
    expect(p).toContain('exitCode')
    expect(p).toContain('render_view')
  })

  it('renders a sample program to static markup', () => {
    const html = renderToStaticMarkup(<Renderer response={RENDER_VIEW_EXAMPLE} library={library} />)
    expect(html).toContain('Build result')
    expect(html).toContain('Duration ms')
    expect(html).toContain('1240')
    expect(html).toContain('compiled 12 files')
    expect(html).toContain('exit 0')
    expect(html).toContain('b.ts')
    expect(html).toContain('340')
    expect(html).toContain('Re-run')
  })

  it('renders a BarChart as inline SVG', () => {
    const src = 'root = Stack([c])\nc = BarChart(["a", "b"], [1, 3], "Sizes")'
    const html = renderToStaticMarkup(<Renderer response={src} library={library} />)
    expect(html).toContain('<svg')
    expect(html).toContain('Sizes')
    expect(html).toContain('<rect')
  })
})

describe('dist/view.html', () => {
  beforeAll(() => {
    execFileSync('node', ['build.mjs'], { cwd: pkg, stdio: 'pipe' })
  })

  it('is one self-contained file with no external src/href', () => {
    const file = resolve(pkg, 'dist/view.html')
    expect(existsSync(file)).toBe(true)
    const html = readFileSync(file, 'utf8')
    expect(html).not.toMatch(/\s(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i)
    expect(html).not.toMatch(/<link\b/i)
    expect(html).not.toMatch(/<script[^>]+src=/i)
    expect(html).toContain('ui/notifications/tool-result')
    expect(html).toContain('ui/initialize')
  })
})
