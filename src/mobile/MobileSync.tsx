import { useEffect, useState } from 'react'
import type { PcModelCatalog, PcModelInfo, TrustedDevice } from '../shared/types'
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
  const [pcModels, setPcModels] = useState<PcModelCatalog | null>(null)
  const [selectedModel, setSelectedModel] = useState('')
  const [message, setMessage] = useState('')
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null)
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
      const modelIssue = summary.modelErrors?.length
        ? ` Model issue: ${summary.modelErrors[0]}${summary.modelErrors.length > 1 ? ` (+${summary.modelErrors.length - 1} more)` : ''}`
        : ''
      const discovery = summary.modelDiscovery
        ? ` PC discovery: ${summary.modelDiscovery.manifestCount} manifests at ${summary.modelDiscovery.root}${summary.modelDiscovery.names.length ? ` [${summary.modelDiscovery.names.join(', ')}]` : ''}.`
        : ''
      setMessage(
        `Imported ${summary.conversations} chats, ${summary.messages} messages, ${summary.avatars ?? 0} avatars, ${summary.models ?? 0} models.${modelIssue}${discovery}`
      )
    } catch (error) {
      report(error)
    }
  }

  const describePcModels = (catalog: PcModelCatalog): string => {
    if (catalog.models.length === 0) {
      const info = catalog.discovery
        ? ` PC discovery: ${catalog.discovery.manifestCount} manifests at ${catalog.discovery.root}${catalog.discovery.names.length ? ` [${catalog.discovery.names.join(', ')}]` : ''}.`
        : ''
      return `No models found on the PC.${info}`
    }
    return `Found ${catalog.models.length} PC model(s).`
  }

  const listPcModels = async (): Promise<void> => {
    if (!connected) {
      setMessage('Connect to the desktop bridge first.')
      return
    }
    setSyncBusy(true)
    try {
      const catalog = await controls.listPcModels()
      setPcModels(catalog)
      setSelectedModel((current) => current && catalog.models.some((model) => model.name === current)
        ? current
        : catalog.models[0]?.name ?? '')
      setMessage(describePcModels(catalog))
    } catch (error) {
      report(error)
    } finally {
      setSyncBusy(false)
    }
  }

  const downloadPcModel = async (): Promise<void> => {
    if (!selectedModel) {
      setMessage('List PC models first, then choose one to download.')
      return
    }
    setSyncBusy(true)
    setDownloadProgress(0)
    setMessage(`Downloading ${selectedModel}… 0%`)
    try {
      const result = await controls.downloadPcModel(selectedModel, (percent) => {
        setDownloadProgress(percent)
        setMessage(`Downloading ${selectedModel}… ${percent}%`)
      })
      const phoneModels = await controls.models()
      const names = phoneModels.map((model) => model.name)
      const phoneText = names.length
        ? ` Phone models: ${names.length} [${names.join(', ')}].`
        : ' Phone models: 0 — the download finished but the phone did not register a GGUF file.'
      const errorText = result.errors.length ? ` ${result.errors[0]}` : ''
      setMessage(
        `Model download: ${result.downloaded} downloaded, ${result.skipped} already present.${phoneText}${errorText}`
      )
    } catch (error) {
      report(error)
    } finally {
      setDownloadProgress(null)
      setSyncBusy(false)
    }
  }

  const modelSize = (model: PcModelInfo): string => {
    const gib = model.size / (1024 ** 3)
    return gib >= 1 ? `${gib.toFixed(1)} GiB` : `${Math.max(1, Math.round(model.size / (1024 ** 2)))} MiB`
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
        <h3>Download Model From PC</h3>
        <p className="sync-hint">Fetch a GGUF model directly without importing the rest of the PC snapshot.</p>
        <div className="sync-actions">
          <button type="button" className="sync-button" disabled={!connected || syncBusy} onClick={() => void listPcModels()}>
            List models on PC
          </button>
          <button type="button" className="sync-button" disabled={!connected || syncBusy || !selectedModel} onClick={() => void downloadPcModel()}>
            Download Model From PC
          </button>
        </div>
        {pcModels && pcModels.models.length > 0 ? (
          <label className="model-select">
            Model
            <select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)}>
              {pcModels.models.map((model) => (
                <option key={model.name} value={model.name}>
                  {model.name} · {modelSize(model)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="sync-hint">No PC models listed yet. Tap <strong>List models on PC</strong>.</p>
        )}
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

      {downloadProgress !== null && (
        <progress className="sync-progress" value={downloadProgress} max={100} />
      )}
      {message && <div className="sync-message" role="status">{message}</div>}
    </div>
  )
}
