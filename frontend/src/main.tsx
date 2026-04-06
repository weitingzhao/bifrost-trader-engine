import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initApiRouting } from './api/shared/apiRouting'
import App from './App'

void initApiRouting().then(
  () => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  },
  (err: unknown) => {
    const el = document.getElementById('root')
    const msg = err instanceof Error ? err.message : String(err)
    if (el) {
      el.textContent = msg
    } else {
      console.error(msg)
    }
  },
)
