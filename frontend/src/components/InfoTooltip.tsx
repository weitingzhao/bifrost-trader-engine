import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { w9 } from '@/styles/wave9Classes'

/** ? icon that shows tooltip on hover/focus. Radix Tooltip escapes overflow:hidden containers. */
export function InfoTooltip({ text }: { text: string }) {
  return (
    <span className={w9.infoTooltipWrap}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={w9.infoTooltipIcon} tabIndex={0} aria-label={text}>?</span>
        </TooltipTrigger>
        <TooltipContent className={w9.infoTooltipPopup} side="top" sideOffset={4}>
          {text}
        </TooltipContent>
      </Tooltip>
    </span>
  )
}
