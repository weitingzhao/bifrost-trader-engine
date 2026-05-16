import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

/** ? icon that shows tooltip on hover/focus. Radix Tooltip escapes overflow:hidden containers. */
export function InfoTooltip({ text }: { text: string }) {
  return (
    <span className="info-tooltip-wrap">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="info-tooltip-icon" tabIndex={0} aria-label={text}>?</span>
        </TooltipTrigger>
        <TooltipContent className="info-tooltip-popup" side="top" sideOffset={4}>
          {text}
        </TooltipContent>
      </Tooltip>
    </span>
  )
}
