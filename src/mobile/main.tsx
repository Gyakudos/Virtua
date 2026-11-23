import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../renderer/src/styles.css'
import './mobile.css'
import { installMobileApi } from './api'
import MobileHost from './MobileHost'

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root element.')

const { mode, controls } = installMobileApi()

createRoot(container).render(
  <StrictMode>
    <MobileHost mode={mode} controls={controls} />
  </StrictMode>
)
