import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.tsx'
import { JobsProvider } from './jobs.tsx'
import { UiProvider } from './ui.tsx'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <UiProvider>
        <JobsProvider>
          <App />
        </JobsProvider>
      </UiProvider>
    </BrowserRouter>
  </StrictMode>,
)
