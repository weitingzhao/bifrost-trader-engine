'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AppProvider } from '@/contexts/AppContext'
import { initApiRouting, getConfigProfile } from '@/api/shared/apiRouting'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false },
  },
})

function applyFaviconForEnv(profile: 'dev' | 'prod' | null) {
  if (typeof document === 'undefined') return
  const href =
    profile === 'prod'
      ? '/favicon-prod.svg'
      : profile === 'dev'
        ? '/favicon-dev.svg'
        : '/favicon.svg'
  let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']")
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    link.type = 'image/svg+xml'
    document.head.appendChild(link)
  }
  link.type = 'image/svg+xml'
  link.href = href
}

export function Providers({ children }: { children: ReactNode }) {
  const [apiReady, setApiReady] = useState(false)
  const [apiError, setApiError] = useState<string | null>(null)

  useEffect(() => {
    void initApiRouting().then(
      () => {
        setApiReady(true)
        setApiError(null)
        applyFaviconForEnv(getConfigProfile())
      },
      (err: unknown) => {
        setApiReady(true)
        setApiError(err instanceof Error ? err.message : String(err))
      },
    )
  }, [])

  if (!apiReady) {
    return (
      <div className="flex min-h-svh items-center justify-center p-6 text-sm text-muted-foreground">
        Initializing API routing…
      </div>
    )
  }

  if (apiError) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-2 p-6 text-sm text-destructive">
        <span>API routing failed to initialize.</span>
        <span className="text-muted-foreground">{apiError}</span>
      </div>
    )
  }

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        <AppProvider>{children}</AppProvider>
      </TooltipProvider>
    </QueryClientProvider>
  )
}
