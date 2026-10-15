import { Renderer } from '@openuidev/react-lang'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { handleToolResponse, library } from './catalog.js'

type HostMessage = { jsonrpc?: string; method?: string; params?: any; id?: unknown; result?: unknown; error?: any }

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

function View() {
  const [src, setSrc] = useState<string | null>(null)
  const [streaming, setStreaming] = useState(false)
  useEffect(() => {
    const onMsg = (e: MessageEvent<HostMessage>) => {
      if (e.source !== window.parent) return
      const m = e.data
      if (m?.jsonrpc !== '2.0') return
      if (m.method === 'ui/notifications/tool-result') {
        const s = str(m.params?.structuredContent?.openui)
        if (s !== null) { setSrc(s); setStreaming(false) }
      } else if (m.method === 'ui/notifications/tool-input' || m.method === 'ui/notifications/tool-input-partial') {
        const s = str(m.params?.arguments?.openui)
        if (s !== null) { setSrc(s); setStreaming(true) }
      } else if (!m.method && m.id === 1) {
        window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*')
      } else if (!m.method) {
        handleToolResponse(m)
      }
    }
    window.addEventListener('message', onMsg)
    window.parent.postMessage({
      jsonrpc: '2.0', id: 1, method: 'ui/initialize',
      params: { protocolVersion: '2025-06-18', appInfo: { name: 'sandbank-openui-view', version: '0.1.0' }, appCapabilities: {} },
    }, '*')
    return () => window.removeEventListener('message', onMsg)
  }, [])
  if (src === null) return <p className="muted">Waiting for view…</p>
  return <Renderer response={src} library={library} isStreaming={streaming} />
}

createRoot(document.getElementById('root')!).render(<View />)
