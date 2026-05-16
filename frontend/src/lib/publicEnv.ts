/**
 * Read Vite-style or Next-style public env vars (client-safe).
 * Next: use NEXT_PUBLIC_* in .env.local; legacy VITE_* still supported when set in build env.
 */
function fromProcess(key: string): string | undefined {
  if (typeof process === 'undefined' || !process.env) return undefined
  const v = process.env[key]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

/** Prefer NEXT_PUBLIC_FOO, then VITE_FOO */
export function publicEnv(viteKey: `VITE_${string}`): string | undefined {
  const nextKey = viteKey.replace(/^VITE_/, 'NEXT_PUBLIC_') as `NEXT_PUBLIC_${string}`
  return fromProcess(nextKey) ?? fromProcess(viteKey)
}

export function isDevBuild(): boolean {
  return fromProcess('NODE_ENV') !== 'production'
}

export function baseUrlForStaticAssets(): string {
  return fromProcess('NEXT_PUBLIC_BASE_PATH') ?? '/'
}
