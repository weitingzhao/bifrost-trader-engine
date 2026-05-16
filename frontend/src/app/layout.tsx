import type { Metadata } from 'next'
import { DM_Sans, JetBrains_Mono } from 'next/font/google'

import './globals.css'
import { Providers } from './providers'

const dmSans = DM_Sans({
  subsets: ['latin'],
  variable: '--font-dm-sans',
  display: 'swap',
})

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jb-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Bifrost Trader',
  description: 'Bifrost Trader Engine monitoring UI',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${dmSans.variable} ${jetbrainsMono.variable}`} suppressHydrationWarning>
      <body className="min-h-svh font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
