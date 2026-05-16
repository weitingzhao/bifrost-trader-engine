import { useEffect, useMemo, useState } from 'react'
import {
  fetchDocsApiHealth,
  fetchHealth,
  fetchHealthAtOrigin,
  fetchMassiveApiHealth,
} from '../api'
import { API_HEALTH_FETCH_TIMEOUT_MS } from '../api/shared/fetchTimeout'
import { fetchOpsHealth } from '../api/ops/ops'
import { normalizeUtilizedServices, type UtilizedServiceRow } from '../utils/utilizedServices'
import { portfolioServiceBase, tradingServiceBase } from '../views/account/accountSidecarBases'
import { marketServiceBase, researchServiceBase, strategyServiceBase } from '../views/research/researchApiBases'

const POLL_MS = 20_000

/** Shared by App header shortcuts and Settings → API sidebar (single poll in App). */
export interface SettingsApiHealthProbesState {
  utilizedServices: UtilizedServiceRow[]
  architectureApiLamp: 'green' | 'red' | 'none'
  accountApiLamp: 'green' | 'yellow' | 'red' | 'none'
  researchApiLamp: 'green' | 'yellow' | 'red' | 'none'
  massiveApiLamp: 'green' | 'red' | 'none'
  opsApiLamp: 'green' | 'red' | 'none'
}

/**
 * Same API health probes as Settings → API sidebar (Monitor/Docs/Ops, sidecars, Massive).
 * Run once in App (header + Settings consume the same snapshot).
 */
export function useSettingsApiHealthProbes(enabled: boolean): SettingsApiHealthProbesState {
  const [massiveApiHealthOk, setMassiveApiHealthOk] = useState<boolean | null>(null)
  const [monitorApiHealthOk, setMonitorApiHealthOk] = useState<boolean | null>(null)
  const [docsApiHealthOk, setDocsApiHealthOk] = useState<boolean | null>(null)
  const [opsApiHealthOk, setOpsApiHealthOk] = useState<boolean | null>(null)
  const [tradingApiHealthOk, setTradingApiHealthOk] = useState<boolean | null>(null)
  const [portfolioApiHealthOk, setPortfolioApiHealthOk] = useState<boolean | null>(null)
  const [researchApiHealthOk, setResearchApiHealthOk] = useState<boolean | null>(null)
  const [strategyApiHealthOk, setStrategyApiHealthOk] = useState<boolean | null>(null)
  const [marketApiHealthOk, setMarketApiHealthOk] = useState<boolean | null>(null)
  const [utilizedServices, setUtilizedServices] = useState<UtilizedServiceRow[]>([])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const load = () => {
      fetchMassiveApiHealth()
        .then(() => {
          if (!cancelled) setMassiveApiHealthOk(true)
        })
        .catch(() => {
          if (!cancelled) setMassiveApiHealthOk(false)
        })
      fetchDocsApiHealth()
        .then(() => {
          if (!cancelled) setDocsApiHealthOk(true)
        })
        .catch(() => {
          if (!cancelled) setDocsApiHealthOk(false)
        })
      fetchOpsHealth()
        .then(() => {
          if (!cancelled) setOpsApiHealthOk(true)
        })
        .catch(() => {
          if (!cancelled) setOpsApiHealthOk(false)
        })
      fetchHealth({ timeoutMs: API_HEALTH_FETCH_TIMEOUT_MS })
        .then((h) => {
          if (!cancelled) {
            setUtilizedServices(normalizeUtilizedServices(h.utilized_services))
            setMonitorApiHealthOk(true)
          }
          const mh = { trading_port: h.trading_port, portfolio_port: h.portfolio_port }
          const tb = tradingServiceBase(mh)
          const pb = portfolioServiceBase(mh)
          if (tb) {
            fetchHealthAtOrigin(tb, { timeoutMs: API_HEALTH_FETCH_TIMEOUT_MS })
              .then(() => {
                if (!cancelled) setTradingApiHealthOk(true)
              })
              .catch(() => {
                if (!cancelled) setTradingApiHealthOk(false)
              })
          } else if (!cancelled) setTradingApiHealthOk(null)
          if (pb) {
            fetchHealthAtOrigin(pb, { timeoutMs: API_HEALTH_FETCH_TIMEOUT_MS })
              .then(() => {
                if (!cancelled) setPortfolioApiHealthOk(true)
              })
              .catch(() => {
                if (!cancelled) setPortfolioApiHealthOk(false)
              })
          } else if (!cancelled) setPortfolioApiHealthOk(null)
          const mhR = {
            research_port: h.research_port,
            strategy_port: h.strategy_port,
            market_port: h.market_port,
          }
          const rr = researchServiceBase(mhR)
          const sr = strategyServiceBase(mhR)
          const mr = marketServiceBase(mhR)
          if (rr) {
            fetchHealthAtOrigin(rr, { timeoutMs: API_HEALTH_FETCH_TIMEOUT_MS })
              .then(() => {
                if (!cancelled) setResearchApiHealthOk(true)
              })
              .catch(() => {
                if (!cancelled) setResearchApiHealthOk(false)
              })
          } else if (!cancelled) setResearchApiHealthOk(null)
          if (sr) {
            fetchHealthAtOrigin(sr, { timeoutMs: API_HEALTH_FETCH_TIMEOUT_MS })
              .then(() => {
                if (!cancelled) setStrategyApiHealthOk(true)
              })
              .catch(() => {
                if (!cancelled) setStrategyApiHealthOk(false)
              })
          } else if (!cancelled) setStrategyApiHealthOk(null)
          if (mr) {
            fetchHealthAtOrigin(mr, { timeoutMs: API_HEALTH_FETCH_TIMEOUT_MS })
              .then(() => {
                if (!cancelled) setMarketApiHealthOk(true)
              })
              .catch(() => {
                if (!cancelled) setMarketApiHealthOk(false)
              })
          } else if (!cancelled) setMarketApiHealthOk(null)
        })
        .catch(() => {
          if (!cancelled) {
            setUtilizedServices([])
            setMonitorApiHealthOk(false)
          }
          const tb = tradingServiceBase(null)
          const pb = portfolioServiceBase(null)
          if (tb) {
            fetchHealthAtOrigin(tb, { timeoutMs: API_HEALTH_FETCH_TIMEOUT_MS })
              .then(() => {
                if (!cancelled) setTradingApiHealthOk(true)
              })
              .catch(() => {
                if (!cancelled) setTradingApiHealthOk(false)
              })
          } else if (!cancelled) setTradingApiHealthOk(null)
          if (pb) {
            fetchHealthAtOrigin(pb, { timeoutMs: API_HEALTH_FETCH_TIMEOUT_MS })
              .then(() => {
                if (!cancelled) setPortfolioApiHealthOk(true)
              })
              .catch(() => {
                if (!cancelled) setPortfolioApiHealthOk(false)
              })
          } else if (!cancelled) setPortfolioApiHealthOk(null)
          const rr = researchServiceBase(null)
          const sr = strategyServiceBase(null)
          const mr = marketServiceBase(null)
          if (rr) {
            fetchHealthAtOrigin(rr, { timeoutMs: API_HEALTH_FETCH_TIMEOUT_MS })
              .then(() => {
                if (!cancelled) setResearchApiHealthOk(true)
              })
              .catch(() => {
                if (!cancelled) setResearchApiHealthOk(false)
              })
          } else if (!cancelled) setResearchApiHealthOk(null)
          if (sr) {
            fetchHealthAtOrigin(sr, { timeoutMs: API_HEALTH_FETCH_TIMEOUT_MS })
              .then(() => {
                if (!cancelled) setStrategyApiHealthOk(true)
              })
              .catch(() => {
                if (!cancelled) setStrategyApiHealthOk(false)
              })
          } else if (!cancelled) setStrategyApiHealthOk(null)
          if (mr) {
            fetchHealthAtOrigin(mr, { timeoutMs: API_HEALTH_FETCH_TIMEOUT_MS })
              .then(() => {
                if (!cancelled) setMarketApiHealthOk(true)
              })
              .catch(() => {
                if (!cancelled) setMarketApiHealthOk(false)
              })
          } else if (!cancelled) setMarketApiHealthOk(null)
        })
    }
    load()
    const t = window.setInterval(load, POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(t)
    }
  }, [enabled])

  return useMemo(() => {
    const monitorApiLamp: 'green' | 'red' | 'none' =
      monitorApiHealthOk === true ? 'green' : monitorApiHealthOk === false ? 'red' : 'none'
    const docsApiLamp: 'green' | 'red' | 'none' =
      docsApiHealthOk === true ? 'green' : docsApiHealthOk === false ? 'red' : 'none'
    const opsApiLamp: 'green' | 'red' | 'none' =
      opsApiHealthOk === true ? 'green' : opsApiHealthOk === false ? 'red' : 'none'
    const architectureApiLamp: 'green' | 'red' | 'none' =
      monitorApiLamp === 'red' || docsApiLamp === 'red' || opsApiLamp === 'red'
        ? 'red'
        : monitorApiLamp === 'green' && docsApiLamp === 'green' && opsApiLamp === 'green'
          ? 'green'
          : 'none'
    const accountApiLamp: 'green' | 'yellow' | 'red' | 'none' = (() => {
      const a = tradingApiHealthOk
      const b = portfolioApiHealthOk
      if (a === null || b === null) return 'none'
      if (a === true && b === true) return 'green'
      if (a === false && b === false) return 'red'
      return 'yellow'
    })()
    const researchApiLamp: 'green' | 'yellow' | 'red' | 'none' = (() => {
      const a = researchApiHealthOk
      const b = strategyApiHealthOk
      const c = marketApiHealthOk
      if (a === null || b === null || c === null) return 'none'
      if (a === true && b === true && c === true) return 'green'
      if (a === false && b === false && c === false) return 'red'
      return 'yellow'
    })()
    const massiveApiLamp: 'green' | 'red' | 'none' =
      massiveApiHealthOk === true ? 'green' : massiveApiHealthOk === false ? 'red' : 'none'

    return {
      utilizedServices,
      architectureApiLamp,
      accountApiLamp,
      researchApiLamp,
      massiveApiLamp,
      opsApiLamp,
    }
  }, [
    utilizedServices,
    monitorApiHealthOk,
    docsApiHealthOk,
    opsApiHealthOk,
    tradingApiHealthOk,
    portfolioApiHealthOk,
    researchApiHealthOk,
    strategyApiHealthOk,
    marketApiHealthOk,
    massiveApiHealthOk,
  ])
}
