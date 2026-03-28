import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initApiRouting } from './api/shared/apiRouting'
import App from './App'

void initApiRouting().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
