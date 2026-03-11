export const MSG_AUTO_CLEAR_MS = 5000

export function setMsg(
  setter: (v: { text: string; isErr: boolean }) => void,
  text: string,
  isErr: boolean,
) {
  setter({ text, isErr })
}

export function scheduleMsgClear(
  setter: (v: { text: string; isErr: boolean }) => void,
  timeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>,
  delayMs: number = MSG_AUTO_CLEAR_MS,
) {
  if (timeoutRef.current != null) clearTimeout(timeoutRef.current)
  timeoutRef.current = setTimeout(() => {
    setter({ text: '', isErr: false })
    timeoutRef.current = null
  }, delayMs)
}
