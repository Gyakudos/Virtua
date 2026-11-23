import Avatar from '../renderer/src/Avatar'
import type { AvatarConfig, AvatarState } from '../shared/types'

interface Props {
  state: AvatarState
  config: AvatarConfig
  onPatch(patch: Partial<AvatarConfig>): void
  onOpen(): void
}

const STATE_LABEL: Record<AvatarState, string> = {
  idle: 'Idle',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  error: 'Needs attention'
}

/** Compact, tappable avatar preview embedded in the phone chat screen. */
export default function MobileAvatarPanel({ state, config, onPatch, onOpen }: Props) {
  const name = config.vrmPath?.split(/[\\/]/).pop() ?? ''
  return (
    <div
      className="mobile-avatar-strip"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
    >
      <div className="mobile-avatar-stage">
        <Avatar state={state} config={{ ...config, visible: true }} onPatch={onPatch} />
      </div>
      <div className="mobile-avatar-caption">
        <strong>{STATE_LABEL[state]}</strong>
        <small>{name || '2D sprite · tap to add a VRM'}</small>
      </div>
      <span className="mobile-avatar-chevron" aria-hidden="true">›</span>
    </div>
  )
}
