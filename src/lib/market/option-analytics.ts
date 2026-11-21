import { fnoInstrumentSchema } from "../groww/instrument-schemas.ts";
import type { FnoInstrument } from "../groww/instrument-schemas.ts";
import { regularMarketSession } from "./market-session.ts";

type PricingInput = {
  type: "CE" | "PE"; spot: number; strike: number; years: number;
  volatility: number; rate: number; dividend: number;
};
const yearMs = 365 * 86400_000;
export function freshOptionTimestamp(time: number | null, now: number) {
  const maximum = 8_640_000_000_000_000 - 330 * 60_000;
  return time !== null && Number.isSafeInteger(time) && time > 0 && time <= maximum &&
    Number.isFinite(now) && now > 0 && now <= maximum && now - time <= 60_000 && time <= now + 5000 &&
    regularMarketSession(time).date === regularMarketSession(now).date;
}
const density = (x: number) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
function normalCdf(x: number) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const tail = density(x) * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - tail : tail;
}

export function blackScholes(input: PricingInput) {
  const { type, spot: s, strike: k, years: t, volatility: v, rate: r, dividend: q } = input;
  if (!["CE", "PE"].includes(type) || ![s, k, t, v, r, q].every(Number.isFinite) || Math.min(s, k, t, v) <= 0) {
    throw new Error("Option pricing needs positive spot, strike, time and volatility, with finite rate and dividend inputs.");
  }
  const root = Math.sqrt(t), discountedSpot = s * Math.exp(-q * t), discountedStrike = k * Math.exp(-r * t);
  const d1 = (Math.log(s / k) + (r - q + v * v / 2) * t) / (v * root), d2 = d1 - v * root;
  const sign = type === "CE" ? 1 : -1;
  const nd1 = normalCdf(sign * d1), nd2 = normalCdf(sign * d2), pdf = density(d1);
  const result = {
    price: sign * (discountedSpot * nd1 - discountedStrike * nd2),
    delta: sign * Math.exp(-q * t) * nd1,
    gamma: Math.exp(-q * t) * pdf / (s * v * root),
    theta: (-discountedSpot * pdf * v / (2 * root) - sign * r * discountedStrike * nd2
      + sign * q * discountedSpot * nd1) / 365,
    vega: discountedSpot * pdf * root / 100,
    rho: sign * t * discountedStrike * nd2 / 100,
    itmProbability: normalCdf(sign * d2),
  };
  if (!Object.values(result).every(Number.isFinite) || result.price < -1e-8) {
    throw new Error("Option pricing is numerically unstable for these inputs.");
  }
  return { ...result, price: Math.max(0, result.price) };
}

export function optionImpliedVolatility(input: Omit<PricingInput, "volatility">, premium: number) {
  if (!Number.isFinite(premium) || premium <= 0) throw new Error("A positive traded option premium is required for implied volatility.");
  let low = 0.0001, high = 5;
  const minimum = blackScholes({ ...input, volatility: low }).price;
  const maximum = blackScholes({ ...input, volatility: high }).price;
  const tolerance = Math.max(1e-8, premium * 1e-8);
  if (premium <= minimum + tolerance || premium >= maximum - tolerance) {
    throw new Error("IV cannot be identified within 0.01%-500%: premium is at/outside model bounds or too insensitive to volatility. Check prices, dividends and expiry.");
  }
  for (let iteration = 0; iteration < 80; iteration++) {
    const middle = (low + high) / 2;
    const price = blackScholes({ ...input, volatility: middle }).price;
    if (Math.abs(price - premium) <= tolerance) return middle;
    if (price < premium) low = middle;
    else high = middle;
  }
  throw new Error("Implied volatility did not converge. Review the price and model assumptions.");
}

export type OptionAnalyticsInput = {
  instrument: FnoInstrument; now: number;
  premium: number; premiumTime: number | null; spot: number; spotTime: number | null;
  ratePercent: number; dividendPercent: number; ivPercent: number | null;
  entryPremium: number; lots: number;
};
export function calculateOptionAnalytics(input: OptionAnalyticsInput) {
  const { instrument, now, premium, premiumTime, spot, spotTime, ratePercent, dividendPercent, ivPercent, entryPremium, lots } = input;
  if (!fnoInstrumentSchema.safeParse(instrument).success || instrument.instrumentType === "FUT" || instrument.strikePrice === null) {
    throw new Error("Option Greeks require a verified CE or PE contract, not a future.");
  }
  if (![now, premium, spot, ratePercent, dividendPercent, entryPremium, lots].every(Number.isFinite) ||
    Math.min(now, premium, spot, entryPremium) <= 0 || !Number.isSafeInteger(lots) || lots < 1 || lots > 100_000 ||
    ratePercent < -20 || ratePercent > 50 || dividendPercent < 0 || dividendPercent > 50 ||
    ivPercent !== null && (!Number.isFinite(ivPercent) || ivPercent < 0.01 || ivPercent > 500)) {
    throw new Error("Enter valid prices, 1-100000 lots, rate -20% to 50%, dividend 0% to 50%, and optional IV 0.01% to 500%.");
  }
  for (const [label, time] of [["Option premium", premiumTime], ["Underlying spot", spotTime]] as const) {
    if (!freshOptionTimestamp(time, now)) {
      throw new Error(`${label} needs a same-day trade less than 60 seconds old. Refresh or reconnect the feed.`);
    }
  }
  if (Math.abs(premiumTime! - spotTime!) > 30_000) throw new Error("Option and underlying trade times differ by more than 30 seconds; wait for synchronized prices.");
  const expiryAt = Date.parse(`${instrument.expiry}T15:30:00+05:30`);
  const years = (expiryAt - now) / yearMs;
  if (!Number.isFinite(years) || years <= 0) throw new Error("This option has expired; pre-expiry Greeks and POP are unavailable.");
  const pricing = { type: instrument.instrumentType, spot, strike: instrument.strikePrice, years,
    rate: ratePercent / 100, dividend: dividendPercent / 100 };
  const volatility = ivPercent === null ? optionImpliedVolatility(pricing, premium) : ivPercent / 100;
  const greeks = blackScholes({ ...pricing, volatility });
  const units = lots * instrument.lotSize;
  if (!Number.isSafeInteger(units)) throw new Error("The selected lot quantity cannot be represented safely.");
  const call = instrument.instrumentType === "CE";
  const discountedSpot = spot * Math.exp(-pricing.dividend * years);
  const discountedStrike = pricing.strike * Math.exp(-pricing.rate * years);
  const lowerBound = Math.max(0, (call ? 1 : -1) * (discountedSpot - discountedStrike));
  const upperBound = call ? discountedSpot : discountedStrike;
  if (premium < lowerBound - 1e-8 || premium > upperBound + 1e-8) {
    throw new Error("The traded premium violates model no-arbitrage bounds. Check prices, dividends and rate assumptions, even when overriding IV.");
  }
  const intrinsic = Math.max(0, (call ? 1 : -1) * (spot - instrument.strikePrice));
  const breakeven = call ? instrument.strikePrice + entryPremium : instrument.strikePrice - entryPremium;
  const drift = (pricing.rate - pricing.dividend - volatility * volatility / 2) * years;
  const width = volatility * Math.sqrt(years);
  const pop = breakeven <= 0 ? 0
    : normalCdf((call ? 1 : -1) * (Math.log(spot / breakeven) + drift) / width);
  const terminalRange = [spot * Math.exp(drift - width), spot * Math.exp(drift + width)];
  const scenarios = [-0.02, 0, 0.02].map(move => {
    const terminalSpot = spot * (1 + move);
    const payoff = Math.max(0, (call ? 1 : -1) * (terminalSpot - pricing.strike));
    return { move, terminalSpot, grossPnl: (payoff - entryPremium) * units };
  });
  const result = { ...greeks, ivPercent: volatility * 100, years, days: years * 365, units, intrinsic,
    extrinsic: premium - intrinsic, breakeven: breakeven > 0 ? breakeven : null, pop, terminalRange,
    maxLoss: entryPremium * units, scenarios };
  if (![result.maxLoss, ...terminalRange, ...scenarios.map(item => item.grossPnl)].every(Number.isFinite)) {
    throw new Error("The selected option assumptions exceed the supported numeric range.");
  }
  return result;
}
