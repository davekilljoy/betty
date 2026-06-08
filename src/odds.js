// Odds ladder: turn a Sleeper projection (a mean) into a spectrum of bettable lines
// at real odds. We model weekly fantasy points as lognormal with mean = projection and
// a position-specific coefficient of variation (CV = sd/mean). RBs are tighter (volume
// is sticky); WR/TE are boom/bust with fatter tails.

const POSITION_CV = {
  QB: 0.32,
  RB: 0.45,
  WR: 0.55,
  TE: 0.62,
  K: 0.40,
  DEF: 0.55,
};
const DEFAULT_CV = 0.50;

// House edge baked into every price (shortens payouts). 5% => the book trends balances
// down over time, so bankroll management matters.
const HOUSE_EDGE = 0.05;

// --- standard normal CDF via Abramowitz & Stegun 7.1.26 erf approximation ---
function erf(x) {
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return s * y;
}
function normCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// Lognormal params for a given mean (mu) and CV.
function lognormalParams(mean, cv) {
  const sigma2 = Math.log(1 + cv * cv);
  const sigma = Math.sqrt(sigma2);
  const m = Math.log(Math.max(mean, 0.01)) - sigma2 / 2; // location
  return { m, sigma };
}

// P(X > t) for X ~ lognormal(m, sigma).
function probOver(threshold, m, sigma) {
  if (threshold <= 0) return 1;
  const z = (Math.log(threshold) - m) / sigma;
  return 1 - normCdf(z);
}

// Decimal odds from a true probability, with house edge applied. Clamped so we never
// offer absurd prices on near-certain or near-impossible legs.
function priceFromProb(p) {
  const clamped = Math.min(0.97, Math.max(0.03, p));
  const fair = 1 / clamped;
  const odds = fair * (1 - HOUSE_EDGE);
  return Math.max(1.02, Math.round(odds * 100) / 100);
}

function toAmerican(decimal) {
  if (decimal >= 2) return `+${Math.round((decimal - 1) * 100)}`;
  return `${Math.round(-100 / (decimal - 1))}`;
}

// Threshold lines always land on n + 0.5 (so a bet can never push to an exact tie).
const nextHalfAbove = (x) => Math.floor(x - 0.5) + 1.5; // smallest n+0.5 strictly > x
const prevHalfBelow = (x) => Math.ceil(x + 0.5) - 1.5;  // largest  n+0.5 strictly < x

// Build a ladder that reads as a number line centered on the projection: UNDER lines sit
// strictly below the line, OVER lines strictly above, each step further out is a longer
// shot. Returned rungs carry their true win-probability (from the final rounded line) so
// the price is honest. `winProbs` are near-the-line -> far-out-longshot.
const WIN_PROBS = [0.44, 0.31, 0.19, 0.10];

function ladderSide(side, projection, m, sigma) {
  const rungs = [];
  let prev = side === 'OVER' ? nextHalfAbove(projection) : prevHalfBelow(projection);
  for (let i = 0; i < WIN_PROBS.length; i++) {
    const wp = WIN_PROBS[i];
    // percentile of the threshold: OVER wins above the (1-wp) quantile; UNDER below the wp quantile
    const z = invNorm(side === 'OVER' ? 1 - wp : wp);
    let t = side === 'OVER'
      ? nextHalfAbove(Math.exp(m + sigma * z))
      : prevHalfBelow(Math.exp(m + sigma * z));
    // enforce strictly monotonic, at least 1 point apart so the rungs don't bunch up
    if (i === 0) t = side === 'OVER' ? Math.max(t, prev) : Math.min(t, prev);
    else t = side === 'OVER' ? Math.max(t, prev + 1) : Math.min(t, prev - 1);
    if (t <= 0) break;
    prev = t;
    const p = side === 'OVER' ? probOver(t, m, sigma) : 1 - probOver(t, m, sigma);
    rungs.push({ side, threshold: t, odds: priceFromProb(p), implied_prob: round3(p) });
  }
  return rungs;
}

function buildLadder(projection, position) {
  const cv = POSITION_CV[position] ?? DEFAULT_CV;
  const { m, sigma } = lognormalParams(projection, cv);
  // unders far->near (ascending toward the line), then overs near->far (ascending away)
  return [
    ...ladderSide('UNDER', projection, m, sigma).reverse(),
    ...ladderSide('OVER', projection, m, sigma),
  ];
}

// Inverse standard normal CDF (Acklam's algorithm) — for inverting the lognormal.
function invNorm(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416];
  const plow = 0.02425, phigh = 1 - plow;
  let q, r;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= phigh) {
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

module.exports = { buildLadder, priceFromProb, toAmerican, HOUSE_EDGE, POSITION_CV };
