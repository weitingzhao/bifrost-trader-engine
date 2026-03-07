import type { StatusResponse } from '../types'

interface TransferPayPageProps {
  status: StatusResponse | null
}

export function TransferPayPage({ status: _status }: TransferPayPageProps) {
  return (
    <div className="replay-main">
      <section className="replay-section" aria-labelledby="transfer-pay-head">
        <h2 id="transfer-pay-head">Transfer & Pay</h2>
        <p className="section-hint">Transfer and payment tools. (Placeholder)</p>
      </section>
    </div>
  )
}
