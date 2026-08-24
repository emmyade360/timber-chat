import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Analytics } from '@vercel/analytics/react'
import './index.css'
import App from './App.jsx'
import AppErrorBoundary from './components/AppErrorBoundary.jsx'
import { inviteCodeFromUrl } from './lib/api.js'
import { startDeepLinks } from './lib/deepLink.js'

// Claim and scrub the landing invite code before anything renders, so the
// capability is out of the URL before the first analytics pageview reads it.
// The result is memoised; onboarding still gets the code it needs.
inviteCodeFromUrl()

// Latch any conversation or call a notification tap is pointing at. Read here
// so the URL is scrubbed before the first analytics pageview, and held until
// the vault is unlocked and the shell can act on it.
startDeepLinks()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
      <Analytics />
    </AppErrorBoundary>
  </StrictMode>,
)
