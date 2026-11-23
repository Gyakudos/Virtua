import AssistantApp from './AssistantApp'
import ChatRP from './ChatRP'

export default function App({ view: suppliedView }: { view?: string | null } = {}) {
  const view = suppliedView ?? new URLSearchParams(window.location.search).get('view')
  return view === 'rp' ? <ChatRP /> : <AssistantApp />
}
