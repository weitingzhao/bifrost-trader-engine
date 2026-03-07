import type { StatusResponse } from '../types'

interface BacktestPageProps {
  status: StatusResponse | null
}

export function BacktestPage({ status: _status }: BacktestPageProps) {
  return (
    <div className="replay-main">
      <section className="replay-section" aria-labelledby="backtest-head">
        <h2 id="backtest-head">Back test</h2>
        <p className="section-hint">Backtest tools. (Placeholder)</p>
      </section>
    </div>
  )
}
