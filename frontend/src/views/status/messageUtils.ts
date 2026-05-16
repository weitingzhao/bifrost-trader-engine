import type { MutableRefObject } from 'react'

export const MSG_AUTO_CLEAR_MS = 5000

export function setMsg(
  setter: (v: { text: string; isErr: boolean }) => void,
  text: string,
  isErr: boolean,
) {
  setter({ text, isErr })
}

/** Browser timer handle (`window.setTimeout`); compatible with DOM typings (numeric id). */
export function scheduleMsgClear(
  setter: (v: { text: string; isErr: boolean }) => void,
  timeoutRef: MutableRefObject<number | null>,
  delayMs: number = MSG_AUTO_CLEAR_MS,
) {
  if (timeoutRef.current != null) window.clearTimeout(timeoutRef.current)
  timeoutRef.current = window.setTimeout(() => {
    setter({ text: '', isErr: false })
    timeoutRef.current = null
  }, delayMs)
}
