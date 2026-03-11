import { useCallback } from 'react'
import { setMsg, scheduleMsgClear } from './messageUtils'

type MsgSetter = (v: { text: string; isErr: boolean }) => void
type ClearRef = React.MutableRefObject<ReturnType<typeof setTimeout> | null>

export interface ControlActionOptions {
  /** Called after a successful API response; may return Promise<unknown> (e.g. loadStatus). */
  onSuccess?: () => Promise<unknown>
}

export interface ControlActionMessages {
  loading: string
  success: string
}

const defaultMessages: ControlActionMessages = {
  loading: '',
  success: '',
}

/**
 * Returns a stable async function that: sets loading message, calls apiFn,
 * sets result message, optionally calls onSuccess, then schedules message clear.
 */
export function useControlAction(
  setter: MsgSetter,
  clearRef: ClearRef,
  options?: ControlActionOptions
) {
  const onSuccess = options?.onSuccess
  return useCallback(
    async (
      apiFn: () => Promise<{ ok?: boolean; error?: string }>,
      messages: ControlActionMessages = defaultMessages
    ) => {
      const { loading, success } = messages
      setMsg(setter, loading, false)
      const res = await apiFn()
      const ok = res.ok === true
      setMsg(setter, ok ? success : res.error ?? '', !ok)
      if (ok && onSuccess) await onSuccess()
      scheduleMsgClear(setter, clearRef)
    },
    [setter, clearRef, onSuccess]
  )
}
