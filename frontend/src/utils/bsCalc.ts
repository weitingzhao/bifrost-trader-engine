/**
 * Black-Scholes math — pure TypeScript.
 * Ported from backend/research/routers/greeks.py.
 *
 * Note: NVDA options are American-style; BS is a European approximation.
 * Near-ATM 21-35 DTE straddle error is acceptable for monitoring purposes.
 */

// ---------------------------------------------------------------------------
// Core math primitives
// ---------------------------------------------------------------------------

export function normCdf(x: number): number {
  // Abramowitz & Stegun approximation — same accuracy as Python math.erf
  return 0.5 * (1.0 + erf(x / Math.SQRT2))
}

export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2.0 * Math.PI)
}

/** Error function approximation (matches Python math.erf to ~1e-7). */
function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1
  const ax = Math.abs(x)
  // Rational approximation for erf (Horner form, Abramowitz & Stegun 7.1.26)
  const t = 1.0 / (1.0 + 0.3275911 * ax)
  const poly =
    t * (0.254829592 +
      t * (-0.284496736 +
        t * (1.421413741 +
          t * (-1.453152027 +
            t * 1.061405429))))
  return sign * (1.0 - poly * Math.exp(-ax * ax))
}

// ---------------------------------------------------------------------------
// BS formula components
// ---------------------------------------------------------------------------

function bsD1D2(
  S: number, K: number, T: number, r: number, sigma: number,
): [number, number] {
  const sqrtT = Math.sqrt(T)
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT)
  const d2 = d1 - sigma * sqrtT
  return [d1, d2]
}

function bsPrice(S: number, K: number, T: number, r: number, sigma: number, right: string): number {
  const [d1, d2] = bsD1D2(S, K, T, r, sigma)
  const discount = Math.exp(-r * T)
  if (right.toUpperCase() === 'C') {
    return S * normCdf(d1) - K * discount * normCdf(d2)
  } else {
    return K * discount * normCdf(-d2) - S * normCdf(-d1)
  }
}

function bsVega(S: number, K: number, T: number, r: number, sigma: number): number {
  const [d1] = bsD1D2(S, K, T, r, sigma)
  return S * normPdf(d1) * Math.sqrt(T)
}

// ---------------------------------------------------------------------------
// Implied Volatility — Newton-Raphson
// ---------------------------------------------------------------------------

function impliedVolNR(
  marketPrice: number, S: number, K: number, T: number, r: number, right: string,
  maxIter = 50,
): { iv: number | null; converged: boolean; iterCount: number } {
  if (T <= 0 || marketPrice <= 0 || S <= 0 || K <= 0) {
    return { iv: null, converged: false, iterCount: 0 }
  }

  // Intrinsic value floor check
  const discount = Math.exp(-r * T)
  const intrinsic = right.toUpperCase() === 'C'
    ? Math.max(0, S - K * discount)
    : Math.max(0, K * discount - S)
  if (marketPrice < intrinsic - 1e-6) {
    return { iv: null, converged: false, iterCount: 0 }
  }

  let sigma = 0.3
  let iterCount = 0
  let converged = false

  for (let i = 0; i < maxIter; i++) {
    iterCount++
    try {
      const price = bsPrice(S, K, T, r, sigma, right)
      const vega = bsVega(S, K, T, r, sigma)
      if (vega < 1e-10) break
      const diff = price - marketPrice
      sigma -= diff / vega
      sigma = Math.max(0.001, Math.min(5.0, sigma))
      if (Math.abs(diff) < 1e-8) {
        converged = true
        break
      }
    } catch {
      break
    }
  }

  // Validation: BS price should be close to market price
  try {
    const check = bsPrice(S, K, T, r, sigma, right)
    if (Math.abs(check - marketPrice) > Math.max(0.05 * marketPrice, 0.05)) {
      return { iv: null, converged: false, iterCount }
    }
  } catch {
    return { iv: null, converged: false, iterCount }
  }

  if (sigma < 0.001 || sigma > 5.0) {
    return { iv: null, converged: false, iterCount }
  }

  return { iv: sigma, converged, iterCount }
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface BSDetail {
  inputs: {
    S: number
    K: number
    tYears: number
    tDays: number
    r: number
    right: string
    marketPrice: number
  }
  iv: number | null
  converged: boolean
  iterCount: number
  initialSigma: number
  // Intermediate values
  sqrtT: number | null
  lnSK: number | null
  d1Numerator: number | null
  d1Denominator: number | null
  d1: number | null
  d2: number | null
  Nd1: number | null
  Nd2: number | null
  nd1: number | null  // normPdf(d1) — used in Gamma/Theta/Vega
  // Greeks
  delta: number | null
  gamma: number | null
  thetaPerDay: number | null
  vegaPer1Pct: number | null
  bsModelPrice: number | null
}

/**
 * Compute BS IV + Greeks with full step-by-step intermediate values.
 * Returns BSDetail with null fields when IV cannot be computed.
 */
export function bsComputeDetail(params: {
  marketPrice: number
  S: number
  K: number
  tYears: number
  r: number
  right: string
}): BSDetail {
  const { marketPrice, S, K, tYears, r, right } = params
  const tDays = Math.round(tYears * 365)
  const inputs = { S, K, tYears, tDays, r, right, marketPrice }

  const { iv, converged, iterCount } = impliedVolNR(marketPrice, S, K, tYears, r, right)

  if (iv == null) {
    return {
      inputs, iv: null, converged: false, iterCount,
      initialSigma: 0.3, sqrtT: null, lnSK: null,
      d1Numerator: null, d1Denominator: null,
      d1: null, d2: null, Nd1: null, Nd2: null, nd1: null,
      delta: null, gamma: null, thetaPerDay: null, vegaPer1Pct: null,
      bsModelPrice: null,
    }
  }

  const sqrtT = Math.sqrt(tYears)
  const lnSK = Math.log(S / K)
  const d1Numerator = lnSK + (r + 0.5 * iv * iv) * tYears
  const d1Denominator = iv * sqrtT
  const d1 = d1Numerator / d1Denominator
  const d2 = d1 - iv * sqrtT

  const Nd1 = normCdf(d1)
  const Nd2 = normCdf(d2)
  const nd1 = normPdf(d1)
  const discount = Math.exp(-r * tYears)

  const gamma = nd1 / (S * iv * sqrtT)

  let delta: number
  let thetaAnnual: number
  if (right.toUpperCase() === 'C') {
    delta = Nd1
    thetaAnnual = -(S * nd1 * iv) / (2.0 * sqrtT) - r * K * discount * Nd2
  } else {
    delta = Nd1 - 1.0
    thetaAnnual = -(S * nd1 * iv) / (2.0 * sqrtT) + r * K * discount * normCdf(-d2)
  }
  const thetaPerDay = thetaAnnual / 365.0
  const vegaPer1Pct = S * nd1 * sqrtT * 0.01

  const bsModelPrice = bsPrice(S, K, tYears, r, iv, right)

  return {
    inputs,
    iv,
    converged,
    iterCount,
    initialSigma: 0.3,
    sqrtT,
    lnSK,
    d1Numerator,
    d1Denominator,
    d1,
    d2,
    Nd1,
    Nd2,
    nd1,
    delta,
    gamma,
    thetaPerDay,
    vegaPer1Pct,
    bsModelPrice,
  }
}
