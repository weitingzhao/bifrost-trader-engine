import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initApiRouting } from './api/apiRouting'
import App from './App'

void initApiRouting().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
