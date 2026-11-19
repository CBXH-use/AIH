import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

async function start() {
  if (!window.aih) {
    const { mockApi } = await import('./mockApi')
    window.aih = mockApi
    window.__AIH_BROWSER__ = true
  }
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

void start()
