import { useEffect, useState } from 'react'
import MobileChat from './MobileChat'
import MobileSync from './MobileSync'
import type { LinkStatus } from './linkedApi'
import type { MobileControls, MobileMode } from './mobile'

type View = 'assistant' | 'rp' | 'sync'

interface Props {
  mode: MobileMode
  controls: MobileControls
}

export default function MobileHost({ mode, controls }: Props) {
  const [view, setView] = useState<View>('assistant')
  const [status, setStatus] = useState<LinkStatus>(controls.linkStatus())
  const [showSetup, setShowSetup] = useState(false)
  const [setupNotice, setSetupNotice] = useState('')
  const [modelInfo, setModelInfo] = useState('')
  const [modeBusy, setModeBusy] = useState(false)

  useEffect(() => controls.onLinkStatus(setStatus), [controls])

  const report = (error: unknown): void => {
    setSetupNotice(error instanceof Error ? error.message : String(error))
  }

  const switchMode = async (next: MobileMode): Promise<void> => {
    setModeBusy(true)
    setSetupNotice('')
    try {
      await controls.setMode(next)
    } catch (error) {
      report(error)
    } finally {
      setModeBusy(false)
    }
  }

  const listModels = async (): Promise<void> => {
    try {
      const list = await controls.models()
      setModelInfo(list.length ? list.map((item) => item.name).join(' · ') : 'No GGUF imported yet.')
    } catch (error) {
      report(error)
    }
  }

  useEffect(() => {
    const refresh = (): void => { void listModels() }
    window.addEventListener('virtua-models-changed', refresh)
    return () => window.removeEventListener('virtua-models-changed', refresh)
  }, [controls])

  const importModel = async (): Promise<void> => {
    try {
      await controls.pickModel()
      setSetupNotice('GGUF imported. Open a chat’s model list to select it.')
      await listModels()
    } catch (error) {
      report(error)
    }
  }

  const importBundle = async (): Promise<void> => {
    try {
      const summary = await controls.importBundle()
      setSetupNotice(`Imported ${summary.conversations} chats and ${summary.messages} messages.`)
    } catch (error) {
      report(error)
    }
  }

  const exportBundle = async (): Promise<void> => {
    try {
      await controls.exportBundle()
      setSetupNotice('Backup exported from this phone.')
    } catch (error) {
      report(error)
    }
  }

  return (
    <div className="mobile-shell">
      <header className="mobile-topbar">
        <div className="mobile-brand">
          <span className="brand-mark" aria-hidden="true">V</span>
          <div>
            <strong>Virtua</strong>
            <small>
              <span className={status === 'connected' ? 'model-dot online' : 'model-dot'} />
              {mode === 'linked' ? `Desktop · ${status}` : 'Running on this phone'}
            </small>
          </div>
        </div>
        <button type="button" className="topbar-action" onClick={() => setShowSetup(true)}>
          Setup
        </button>
      </header>

      <main className="mobile-main">
        {view === 'sync'
          ? <MobileSync controls={controls} status={status} />
          : <MobileChat key={view} kind={view} controls={controls} mode={mode} />}
      </main>

      <nav className="mobile-tabs" aria-label="Main views">
        <button
          type="button"
          className={view === 'assistant' ? 'active' : ''}
          onClick={() => setView('assistant')}
        >
          <span className="tab-icon" aria-hidden="true">✦</span>
          <span>Assistant</span>
        </button>
        <button
          type="button"
          className={view === 'rp' ? 'active' : ''}
          onClick={() => setView('rp')}
        >
          <span className="tab-icon" aria-hidden="true">◈</span>
          <span>Roleplay</span>
        </button>
        <button
          type="button"
          className={view === 'sync' ? 'active' : ''}
          onClick={() => setView('sync')}
        >
          <span className="tab-icon" aria-hidden="true">⇄</span>
          <span>Portable Sync</span>
        </button>
      </nav>

      {showSetup && (
        <div className="sheet-backdrop" onClick={() => setShowSetup(false)}>
          <section className="sheet setup-sheet" onClick={(event) => event.stopPropagation()}>
            <header className="sheet-head">
              <strong>Setup</strong>
              <button type="button" onClick={() => setShowSetup(false)}>Close</button>
            </header>
            <div className="sheet-body">
              <div className="setup-group">
                <h4>Where Virtua runs</h4>
                <div className="segmented">
                  <button
                    type="button"
                    className={mode === 'local' ? 'active' : ''}
                    disabled={modeBusy}
                    onClick={() => void switchMode('local')}
                  >
                    Phone
                  </button>
                  <button
                    type="button"
                    className={mode === 'linked' ? 'active' : ''}
                    disabled={modeBusy}
                    onClick={() => void switchMode('linked')}
                  >
                    Desktop link
                  </button>
                </div>
                <p className="sheet-hint">
                  {modeBusy
                    ? 'Copying your current avatar to this phone and switching…'
                    : mode === 'local'
                      ? 'GGUF models and data stay on this phone. No PC or internet needed.'
                      : 'Uses your desktop over LAN or Tailscale. No cloud relay.'}
                </p>
              </div>

              {mode === 'local' && (
                <div className="setup-group">
                  <h4>On-device files</h4>
                  <div className="setup-actions">
                    <button type="button" className="sync-button" onClick={() => void listModels()}>
                      Model list
                    </button>
                    <button type="button" className="sync-button primary" onClick={() => void importModel()}>
                      Import GGUF
                    </button>
                    <button type="button" className="sync-button" onClick={() => void importBundle()}>
                      Import backup
                    </button>
                    <button type="button" className="sync-button" onClick={() => void exportBundle()}>
                      Export backup
                    </button>
                  </div>
                  {modelInfo && <p className="sheet-hint">{modelInfo}</p>}
                </div>
              )}

              {mode === 'linked' && (
                <div className="setup-group">
                  <h4>Desktop bridge</h4>
                  <p className="sheet-hint">
                    Open <strong>Portable Sync</strong> on the PC and scan its QR from the Portable Sync tab.
                  </p>
                </div>
              )}

              {setupNotice && <div className="sync-message">{setupNotice}</div>}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
