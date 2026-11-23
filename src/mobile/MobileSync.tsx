import { useEffect, useState } from 'react'
import type { TrustedDevice } from '../shared/types'
import { deviceIdentity, type LinkStatus } from './linkedApi'
import type { MobileControls } from './mobile'
import { parsePairLink } from './pairing'

interface Props {
  controls: MobileControls
  status: LinkStatus
}

export default function MobileSync({ controls, status }: Props) {
  const [link, setLink] = useState(controls.linkConfig())
  const [devices, setDevices] = useState<TrustedDevice[]>([])
  const [message, setMessage] = useState('')
  const [syncBusy, setSyncBusy] = useState(false)

  useEffect(() => {
    if (status === 'connected') void refreshDevices()
  }, [status])

  const report = (error: unknown): void => {
    setMessage(error instanceof Error ? error.message : String(error))
  }

  const refreshDevices = async (): Promise<void> => {
    try {
      setDevices(await controls.trustedDevices())
    } catch (error) {
      report(error)
    }
  }

  const scanQr = async (): Promise<void> => {
    setSyncBusy(true)
    try {
      const parsed = parsePairLink(await controls.scanQr())
      controls.setLink(parsed)
      setLink(parsed)
      setMessage(`Paired with ${parsed.url}. Waiting for the desktop link…`)
    } catch (error) {
      report(error)
    } finally {
      setSyncBusy(false)
    }
  }

  const connectManual = (): void => {
    try {
      controls.setLink(link)
      setMessage('Saved. Connecting to the desktop bridge…')
    } catch (error) {
      report(error)
    }
  }

  const syncPull = async (): Promise<void> => {
    try {
      const summary = await controls.pull()
      setMessage(`Imported ${summary.conversations} chats and ${summary.messages} messages.`)
    } catch (error) {
      report(error)
    }
  }

  const syncPush = async (): Promise<void> => {
    try {
      await controls.push()
      setMessage('Local snapshot pushed to the desktop.')
    } catch (error) {
      report(error)
    }
  }

  const setTrust = async (id: string, trusted: boolean): Promise<void> => {
    try {
      if (trusted) await controls.allowDevice(id)
      else await controls.revokeDevice(id)
      await refreshDevices()
      setMessage(trusted ? 'Device allowed again.' : 'Device revoked.')
    } catch (error) {
      report(error)
    }
  }

  const identity = deviceIdentity()
  const connected = status === 'connected'

  return (
    <div className="sync-screen">
      <section className="sync-card hero">
        <strong>Portable Sync</strong>
        <p>
          Pair over your LAN or Tailscale, then pull or push snapshots. No cloud relay and no automatic
          background sync.
        </p>
        <div className={`sync-status ${connected ? 'connected' : ''}`}>
          <span className="model-dot" /> {status}
        </div>
        {controls.linkError() && (
          <div className="bridge-error" role="alert">{controls.linkError()}</div>
        )}
        {controls.mode() === 'linked' && !connected && (
          <button type="button" className="sync-button small" onClick={controls.reconnectLink}>
            Retry connection
          </button>
        )}
      </section>

      <section className="sync-card">
        <h3>Pair with PC</h3>
        <div className="sync-actions">
          <button type="button" className="sync-button primary" disabled={syncBusy} onClick={() => void scanQr()}>
            {syncBusy ? 'Opening camera…' : 'Scan PC QR'}
          </button>
          <button type="button" className="sync-button" disabled={!connected} onClick={() => void refreshDevices()}>
            Refresh devices
          </button>
        </div>
        <p className="sync-hint">Scan the QR in the desktop <strong>Portable Sync</strong> panel.</p>

        <details className="sync-manual">
          <summary>Enter address manually</summary>
          <label>
            Address
            <input
              value={link.url}
              placeholder="http://192.168.1.20:8787"
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(event) => setLink({ ...link, url: event.target.value })}
            />
          </label>
          <label>
            Pairing token
            <input
              value={link.token}
              placeholder="ABCD-EFGH"
              autoCapitalize="characters"
              autoCorrect="off"
              onChange={(event) => setLink({ ...link, token: event.target.value })}
            />
          </label>
          <div className="sync-actions">
            <button type="button" className="sync-button" onClick={connectManual}>Connect</button>
            <button type="button" className="sync-button" disabled={!connected} onClick={() => void syncPull()}>
              Pull from PC
            </button>
            <button type="button" className="sync-button" disabled={!connected} onClick={() => void syncPush()}>
              Push to PC
            </button>
          </div>
        </details>
      </section>

      <section className="sync-card">
        <h3>Trusted devices</h3>
        <p className="sync-hint">This phone: {identity.name} · {identity.id.slice(0, 12)}…</p>
        {devices.length === 0 ? (
          <p className="sync-hint">Connect to the desktop bridge to see trusted phones.</p>
        ) : devices.map((device) => (
          <div key={device.id} className="device-row">
            <div>
              <strong>{device.name}</strong>
              <small>
                {device.platform} · {device.connected ? 'connected now' : `last seen ${new Date(device.lastSeenAt).toLocaleString()}`}
                {' · '}{device.revoked ? 'revoked' : 'trusted'}
              </small>
            </div>
            <button type="button" className="sync-button small" onClick={() => void setTrust(device.id, device.revoked)}>
              {device.revoked ? 'Allow' : 'Revoke'}
            </button>
          </div>
        ))}
      </section>

      {message && <div className="sync-message" role="status">{message}</div>}
    </div>
  )
}
