import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Analytics } from '@vercel/analytics/react'
import './index.css'
import App from './App.jsx'
import AppErrorBoundary from './components/AppErrorBoundary.jsx'
import { inviteCodeFromUrl } from './lib/api.js'

// Claim and scrub the landing invite code before anything renders, so the
// capability is out of the URL before the first analytics pageview reads it.
// The result is memoised; onboarding still gets the code it needs.
inviteCodeFromUrl()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
      <Analytics />
    </AppErrorBoundary>
  </StrictMode>,
)
