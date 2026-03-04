/** ? icon that shows tooltip on hover. Use next to page/section titles to save space. */
export function InfoTooltip({ text }: { text: string }) {
  return (
    <span className="info-tooltip-wrap">
      <span className="info-tooltip-icon" aria-label={text}>?</span>
      <span className="info-tooltip-popup" role="tooltip">{text}</span>
    </span>
  )
}
