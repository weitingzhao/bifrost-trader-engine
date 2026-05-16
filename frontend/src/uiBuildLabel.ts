function fromProcess(key: string): string | undefined {
  if (typeof process === 'undefined' || !process.env) return undefined
  const v = process.env[key]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

/** Shown in the header menu; set at build time via `next.config.mjs` (`NEXT_PUBLIC_UI_BUILD_LABEL`). */
export const UI_BUILD_LABEL: string =
  fromProcess('NEXT_PUBLIC_UI_BUILD_LABEL') ?? 'dev-local'
