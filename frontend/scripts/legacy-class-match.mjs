/** Shared token-level matching for legacy class lint (avoids false positives like action-btn). */

export const BANNED_FRAGMENTS = [
  'card',
  'process-section',
  'btn-',
  'table-scroll',
  'settings-page',
  'lamp-icon',
  'app-header-',
  'page-title-',
  'wl2',
  'od-detail',
  'riv-',
]

export function classTokensFromAttr(classAttr) {
  return classAttr
    .split(/\s+/)
    .flatMap((token) => token.split(/\$\{/)[0].trim())
    .filter(Boolean)
}

export function tokenMatchesBanned(token, frag) {
  if (frag === 'card') return token === 'card'
  if (frag === 'process-section') return token === 'process-section'
  if (frag === 'table-scroll') return token === 'table-scroll' || token.startsWith('table-scroll-')
  if (frag === 'btn-') return token === 'btn' || token.startsWith('btn-')
  if (frag === 'settings-page') return token === 'settings-page' || token.startsWith('settings-page-')
  if (frag === 'lamp-icon') return token === 'lamp-icon'
  if (frag === 'app-header-') return token.startsWith('app-header-')
  if (frag === 'page-title-') return token.startsWith('page-title-')
  if (frag === 'wl2') return token === 'wl2' || token.startsWith('wl2-')
  if (frag === 'od-detail') return token.startsWith('od-detail')
  if (frag === 'riv-') return token.startsWith('riv-')
  return false
}

export function findBannedInText(text) {
  const found = new Set()
  const re = /className\s*=\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g
  let m
  while ((m = re.exec(text)) !== null) {
    const cls = m[1] ?? m[2] ?? m[3] ?? ''
    for (const token of classTokensFromAttr(cls)) {
      for (const frag of BANNED_FRAGMENTS) {
        if (tokenMatchesBanned(token, frag)) found.add(frag)
      }
    }
  }
  return [...found]
}
