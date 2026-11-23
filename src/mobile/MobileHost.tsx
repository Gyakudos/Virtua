import { useEffect, useState } from 'react'
import App from '../renderer/src/App'
import type { TrustedDevice } from '../shared/types'
import { deviceIdentity, type LinkStatus } from './linkedApi'
import type { MobileControls, MobileMode } from './mobile'
import { parsePairLink } from './pairing'

type View = 'assistant' | 'rp' | 'sync'

export default function MobileHost({ mode, controls }: { mode: MobileMode; controls: MobileControls }) {
  const [view, setView] = useState<View>('assistant')
  const [status, setStatus] = useState<LinkStatus>(controls.linkStatus())
  const [link, setLink] = useState(controls.linkConfig())
  const [devices, setDevices] = useState<TrustedDevice[]>([])
  const [message, setMessage] = useState('')
  const [syncBusy, setSyncBusy] = useState(false)

  useEffect(() => controls.onLinkStatus(setStatus), [controls])
  useEffect(() => {
    if (view === 'sync' && status === 'connected') void refreshDevices()
  }, [view, status])

  const report = (error: unknown): void => {
    setMessage(error instanceof Error ? error.message : String(error))
  }

  const refreshDevices = async (): Promise<void> => {
    try {
      setDevices(await controls.trustedDevices())
    } catch (error) { report(error) }
  }

  const scanQr = async (): Promise<void> => {
    setSyncBusy(true)
    try {
      const parsed = parsePairLink(await controls.scanQr())
      controls.setLink(parsed)
      setLink(parsed)
      setMessage(`Paired with ${parsed.url}. Waiting for the desktop link…`)
    } catch (error) { report(error) } finally {
      setSyncBusy(false)
    }
  }

  const connectManual = (): void => {
    try {
      controls.setLink(link)
      setMessage('Saved. Connecting to the desktop bridge…')
    } catch (error) { report(error) }
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

  const setTrust = async (id: string, trusted: boolean): Promise<void> => {
    try {
      if (trusted) await controls.allowDevice(id)
      else await controls.revokeDevice(id)
      await refreshDevices()
      setMessage(trusted ? 'Device allowed again.' : 'Device revoked.')
    } catch (error) { report(error) }
  }

  const identity = deviceIdentity()

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
          <button type="button" className={view === 'sync' ? 'active' : ''} onClick={() => { setView('sync'); void refreshDevices() }}>Portable Sync</button>
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
        </div>
      </details>

      {view === 'sync' && (
        <section className="mobile-sync">
          <div className="mobile-sync-head">
            <strong>Portable Sync</strong>
            <small>Local bridge · {status}</small>
          </div>

          <div className="mobile-sync-block">
            <strong>Pair with PC</strong>
            <div className="mobile-button-row">
              <button type="button" className="primary" disabled={syncBusy} onClick={() => void scanQr()}>
                {syncBusy ? 'Opening camera…' : 'Scan PC QR'}
              </button>
              <button type="button" disabled={status !== 'connected'} onClick={() => void refreshDevices()}>Refresh devices</button>
            </div>
            <small>Scan the QR shown in the desktop <strong>Portable Sync</strong> panel. Nothing is uploaded.</small>
            <details className="mobile-sync-manual">
              <summary>Enter address manually</summary>
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
                <button type="button" onClick={connectManual}>Connect</button>
                <button type="button" disabled={status !== 'connected'} onClick={() => void syncPull()}>Pull from PC</button>
                <button type="button" disabled={status !== 'connected'} onClick={() => void syncPush()}>Push to PC</button>
              </div>
            </details>
          </div>

          <div className="mobile-sync-block">
            <strong>Trusted Devices</strong>
            <small className="muted">This phone: {identity.name} · {identity.id.slice(0, 12)}…</small>
            {devices.length === 0
              ? <small className="muted">Connect to the desktop bridge to see trusted phones.</small>
              : devices.map((device) => (
                <div key={device.id} className="mobile-device-row">
                  <div>
                    <strong>{device.name}</strong>
                    <small>
                      {device.platform} · {device.connected ? 'connected now' : `last seen ${new Date(device.lastSeenAt).toLocaleString()}`}
                      {' · '}{device.revoked ? 'revoked' : 'trusted'}
                    </small>
                  </div>
                  <button type="button" className="small" onClick={() => void setTrust(device.id, device.revoked)}>
                    {device.revoked ? 'Allow' : 'Revoke'}
                  </button>
                </div>
              ))}
          </div>

          {message && <p className="mobile-message">{message}</p>}
        </section>
      )}

      <main className="mobile-app">
        {view === 'sync' ? null : <App view={view} />}
      </main>
    </div>
  )
}
