import { useEffect, useState } from 'react'
import App from '../renderer/src/App'
import type { LinkStatus } from './linkedApi'
import type { MobileControls, MobileMode } from './mobile'

type View = 'assistant' | 'rp'

export default function MobileHost({ mode, controls }: { mode: MobileMode; controls: MobileControls }) {
  const [view, setView] = useState<View>('assistant')
  const [status, setStatus] = useState<LinkStatus>(controls.linkStatus())
  const [link, setLink] = useState(controls.linkConfig())
  const [message, setMessage] = useState('')

  useEffect(() => controls.onLinkStatus(setStatus), [controls])

  const report = (error: unknown): void => {
    setMessage(error instanceof Error ? error.message : String(error))
  }

  const syncPull = async (): Promise<void> => {
    try {
      const summary = await controls.pull()
      setMessage(`Imported ${summary.conversations} chats and ${summary.messages} messages.`)
    } catch (error) { report(error) }
  }

  const syncPush = async (): Promise<void> => {
    try {
      await controls.push()
      setMessage('Local snapshot pushed to the desktop.')
    } catch (error) { report(error) }
  }

  return (
    <div className="mobile-shell">
      <header className="mobile-header">
        <div className="mobile-title">
          <strong>Virtua</strong>
          <small>{mode === 'linked' ? `Linked · ${status}` : 'On-device'}</small>
        </div>
        <div className="mobile-view-switch">
          <button type="button" className={view === 'assistant' ? 'active' : ''} onClick={() => setView('assistant')}>Assistant</button>
          <button type="button" className={view === 'rp' ? 'active' : ''} onClick={() => setView('rp')}>ChatRP</button>
        </div>
      </header>

      <details className="mobile-controls">
        <summary>Mode &amp; sync</summary>
        <div className="mobile-control-grid">
          <div className="mobile-control-block">
            <strong>Where to run</strong>
            <div className="mobile-button-row">
              <button type="button" className={mode === 'local' ? 'active' : ''} onClick={() => controls.setMode('local')}>Phone</button>
              <button type="button" className={mode === 'linked' ? 'active' : ''} onClick={() => controls.setMode('linked')}>Desktop link</button>
            </div>
            <small>
              {mode === 'local'
                ? 'Runs GGUF models and keeps data on this phone. No PC needed.'
                : 'Uses the desktop app over your LAN or Tailscale. No cloud relay.'}
            </small>
          </div>

          {mode === 'local' && (
            <div className="mobile-control-block">
              <strong>Local model</strong>
              <div className="mobile-button-row">
                <button type="button" onClick={() => void controls.models()
                  .then((list) => setMessage(list.length ? `Models: ${list.map((model) => model.name).join(', ')}` : 'No GGUF model imported yet.'))
                  .catch(report)}>Refresh</button>
                <button type="button" onClick={() => void controls.pickModel().then(() => setMessage('GGUF imported. Reload the app to refresh the model list.')).catch(report)}>Import GGUF</button>
                <button type="button" onClick={() => void controls.importBundle().then((s) => setMessage(`Imported ${s.conversations} chats.`)).catch(report)}>Import bundle</button>
                <button type="button" onClick={() => void controls.exportBundle().then(() => setMessage('Bundle exported.')).catch(report)}>Export bundle</button>
              </div>
            </div>
          )}

          {mode === 'linked' && (
            <div className="mobile-control-block">
              <strong>Desktop bridge</strong>
              <label>
                Address
                <input
                  value={link.url}
                  placeholder="http://192.168.1.20:8787"
                  onChange={(event) => setLink({ ...link, url: event.target.value })}
                />
              </label>
              <label>
                Pairing token
                <input
                  value={link.token}
                  placeholder="ABCD-EFGH"
                  onChange={(event) => setLink({ ...link, token: event.target.value })}
                />
              </label>
              <div className="mobile-button-row">
                <button type="button" onClick={() => controls.setLink(link)}>Connect</button>
                <button type="button" disabled={status !== 'connected'} onClick={() => void syncPull()}>Pull from PC</button>
                <button type="button" disabled={status !== 'connected'} onClick={() => void syncPush()}>Push to PC</button>
              </div>
              <small>LAN/mDNS/Tailscale addresses only. Enable the bridge in the desktop Data → system panel.</small>
            </div>
          )}

          {message && <p className="mobile-message">{message}</p>}
        </div>
      </details>

      <main className="mobile-app">
        <App view={view} />
      </main>
    </div>
  )
}
