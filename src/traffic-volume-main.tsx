import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import TrafficVolumeApp from './TrafficVolumeApp.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TrafficVolumeApp />
  </StrictMode>,
)
