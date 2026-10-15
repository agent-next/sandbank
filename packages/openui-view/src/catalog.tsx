import { createLibrary, defineComponent } from '@openuidev/react-lang'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { z } from 'zod/v4'

const children = (v: unknown, render: (n: unknown) => ReactNode): ReactNode =>
  Array.isArray(v) ? v.map((c, i) => <span key={i} style={{ display: 'contents' }}>{render(c)}</span>) : null

export const Stack = defineComponent({
  name: 'Stack',
  description: 'Lays out child components vertically (column) or horizontally (row, wraps).',
  props: z.object({
    children: z.array(z.any()).describe('Child components'),
    direction: z.enum(['column', 'row']).optional().describe('Default column'),
  }),
  component: ({ props, renderNode }) => (
    <div className={`stack ${props.direction === 'row' ? 'row' : ''}`}>{children(props.children, renderNode)}</div>
  ),
})

export const Card = defineComponent({
  name: 'Card',
  description: 'Bordered panel with a title and child components.',
  props: z.object({
    title: z.string().describe('Card heading'),
    children: z.array(z.any()).describe('Child components'),
  }),
  component: ({ props, renderNode }) => (
    <section className="card">
      <h3>{props.title}</h3>
      <div className="stack">{children(props.children, renderNode)}</div>
    </section>
  ),
})

export const Stat = defineComponent({
  name: 'Stat',
  description: 'A single big number with a label, e.g. a count, duration or exit code.',
  props: z.object({
    label: z.string(),
    value: z.union([z.string(), z.number()]),
    tone: z.enum(['neutral', 'good', 'bad']).optional().describe('Color tone, default neutral'),
  }),
  component: ({ props }) => (
    <div className={`stat ${props.tone ?? 'neutral'}`}>
      <div className="stat-value">{String(props.value)}</div>
      <div className="stat-label">{props.label}</div>
    </div>
  ),
})

export const Table = defineComponent({
  name: 'Table',
  description: 'Data table. columns are header labels; each row is an array of cell values in column order.',
  props: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
  }),
  component: ({ props }) => (
    <div className="scroll">
      <table>
        <thead>
          <tr>{(props.columns ?? []).map((c, i) => <th key={i}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {(props.rows ?? []).map((r, i) => (
            <tr key={i}>{(r ?? []).map((c, j) => <td key={j}>{c === null ? '' : String(c)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  ),
})

export const LogBlock = defineComponent({
  name: 'LogBlock',
  description: 'Terminal output: stdout, optional stderr (shown in red) and an optional exit code badge.',
  props: z.object({
    stdout: z.string().describe('Standard output text'),
    stderr: z.string().optional().describe('Standard error text'),
    exitCode: z.number().optional().describe('Process exit code; 0 is success'),
  }),
  component: ({ props }) => (
    <div className="log">
      {props.exitCode !== undefined && (
        <span className={`badge ${props.exitCode === 0 ? 'good' : 'bad'}`}>exit {props.exitCode}</span>
      )}
      {props.stdout ? <pre>{props.stdout}</pre> : null}
      {props.stderr ? <pre className="err">{props.stderr}</pre> : null}
    </div>
  ),
})

export const BarChart = defineComponent({
  name: 'BarChart',
  description: 'Simple horizontal bar chart. labels[i] pairs with values[i].',
  props: z.object({
    labels: z.array(z.string()),
    values: z.array(z.number()),
    title: z.string().optional(),
  }),
  component: ({ props }) => {
    const labels = props.labels ?? []
    const values = props.values ?? []
    const max = Math.max(1, ...values)
    const rowH = 22
    return (
      <figure className="chart">
        {props.title ? <figcaption>{props.title}</figcaption> : null}
        <svg role="img" aria-label={props.title ?? 'bar chart'} viewBox={`0 0 400 ${Math.max(1, labels.length) * rowH}`} width="100%">
          {labels.map((l, i) => {
            const w = ((values[i] ?? 0) / max) * 230
            return (
              <g key={i} transform={`translate(0 ${i * rowH})`}>
                <text x="0" y="15" className="svg-label">{l}</text>
                <rect x="110" y="3" width={w} height="14" rx="2" className="bar" />
                <text x={114 + w} y="15" className="svg-label">{String(values[i] ?? 0)}</text>
              </g>
            )
          })}
        </svg>
      </figure>
    )
  },
})

export const Link = defineComponent({
  name: 'Link',
  description: 'External link, opens in a new tab.',
  props: z.object({ label: z.string(), href: z.string().describe('https URL') }),
  component: ({ props }) => (
    <a href={props.href} target="_blank" rel="noreferrer noopener">{props.label}</a>
  ),
})

/** Tools an ActionButton may call with one click; everything else asks for confirmation. */
export const READ_ONLY_TOOLS = new Set(['providers_list', 'sandbox_list', 'file_read', 'port_expose', 'render_console', 'render_view'])

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }
const pending = new Map<number, Pending>()
let nextId = 1000

/** Sends a JSON-RPC `tools/call` to the MCP Apps host and resolves with its result. */
export function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    window.parent.postMessage({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, '*')
  })
}

/** Feed host messages here; returns true when the message was a response to a callTool request. */
export function handleToolResponse(msg: { id?: unknown; result?: unknown; error?: { message?: string } }): boolean {
  if (typeof msg.id !== 'number') return false
  const p = pending.get(msg.id)
  if (!p) return false
  pending.delete(msg.id)
  if (msg.error) p.reject(new Error(msg.error.message ?? 'tools/call failed'))
  else p.resolve(msg.result)
  return true
}

function summarize(result: unknown): string {
  const r = result as { content?: { type?: string; text?: string }[] } | undefined
  const text = r?.content?.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  return text || JSON.stringify(result, null, 2)
}

export const ActionButton = defineComponent({
  name: 'ActionButton',
  description:
    'Button that calls an MCP tool on this server when clicked (e.g. tool "sandbox_exec") and shows the result inline.',
  props: z.object({
    label: z.string(),
    tool: z.string().describe('MCP tool name'),
    args: z.record(z.string(), z.any()).optional().describe('Tool arguments object'),
  }),
  component: ({ props }) => {
    const [state, setState] = useState<{ status: 'idle' | 'confirm' | 'busy' | 'ok' | 'err'; text?: string }>({ status: 'idle' })
    // The program is model-authored: anything that changes state needs a second, explicit click naming the tool.
    const needsConfirm = !READ_ONLY_TOOLS.has(props.tool)
    const click = () => {
      if (needsConfirm && state.status !== 'confirm') {
        setState({ status: 'confirm' })
        return
      }
      setState({ status: 'busy' })
      callTool(props.tool, props.args ?? {}).then(
        (r) => setState({ status: (r as { isError?: boolean })?.isError ? 'err' : 'ok', text: summarize(r) }),
        (e: Error) => setState({ status: 'err', text: e.message }),
      )
    }
    return (
      <div className="action">
        <button type="button" onClick={click} disabled={state.status === 'busy'} title={`Calls ${props.tool}`}>
          {state.status === 'busy' ? `${props.label}…` : state.status === 'confirm' ? `Confirm: ${props.tool}` : props.label}
        </button>
        {state.status === 'confirm'
          ? <button type="button" onClick={() => setState({ status: 'idle' })}>Cancel</button>
          : null}
        {state.text ? <pre className={state.status === 'err' ? 'err' : ''}>{state.text}</pre> : null}
      </div>
    )
  },
})

export const library = createLibrary({
  components: [Stack, Card, Stat, Table, LogBlock, BarChart, Link, ActionButton],
  root: 'Stack',
})
