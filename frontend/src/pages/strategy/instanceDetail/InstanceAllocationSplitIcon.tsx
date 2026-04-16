/** Split icon for executions shared via account_execution_instance_allocation. */
export function InstanceAllocationSplitIcon({ title }: { title: string }) {
  return (
    <span
      className="instance-exec-allocation-split-icon"
      title={title}
      aria-label={title}
      role="img"
      style={{
        display: 'inline-flex',
        verticalAlign: 'middle',
        marginLeft: '0.35em',
        color: 'var(--color-accent, #5b7cfa)',
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
        <path
          d="M12 4v5M12 9c-2.5 0-4.5 2-4.5 4.5V20M12 9c2.5 0 4.5 2 4.5 4.5V20"
          stroke="currentColor"
          strokeWidth="1.85"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="8" cy="20" r="2" fill="currentColor" />
        <circle cx="16" cy="20" r="2" fill="currentColor" />
      </svg>
    </span>
  )
}
