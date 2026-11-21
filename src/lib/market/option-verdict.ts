import { fnoInstrumentSchema } from "../groww/instrument-schemas.ts";
import { blackScholes, calculateOptionAnalytics, freshOptionTimestamp } from "./option-analytics.ts";
import type { OptionAnalyticsInput } from "./option-analytics.ts";
import { calculateTechnicalVerdict } from "./technical-verdict.ts";
import { intradayEntryCutoff, regularMarketSession } from "./market-session.ts";
import type { AnalysisMode, MarketAnalysis } from "./types.ts";

type Check = { label: string; status: "PASS" | "FAIL" | "UNAVAILABLE"; detail: string };
export type OptionScenario = {
  id: "favorable" | "adverse" | "decay" | "iv" | "rate"; label: string;
  spot: number; ivPercent: number; ratePercent: number; premium: number;
};
export type OptionVerdict = {
  decision: "BUY" | "SELL" | "HOLD"; technicalDecision: "BUY" | "SELL" | "HOLD";
  dataReady: boolean; exitOnly: boolean; summary: string; horizonAt: number | null;
  checks: Check[]; scenarios: OptionScenario[]; stopLoss: number | null; target: number | null;
};

export function calculateOptionVerdict(analysis: MarketAnalysis, mode: AnalysisMode,
  input: OptionAnalyticsInput | null, now = Date.now()): OptionVerdict {
  const technical = calculateTechnicalVerdict(analysis, mode, now);
  const result: OptionVerdict = {
    decision: "HOLD", technicalDecision: technical.decision, dataReady: technical.dataReady, exitOnly: false,
    summary: "HOLD: option model inputs and a valid technical setup are required.",
    horizonAt: null, checks: [], scenarios: [], stopLoss: technical.stopLoss, target: technical.targetPrices[0] ?? null,
  };
  const unavailable = (detail: string) => {
    result.dataReady = false;
    result.checks.push({ label: "Option data / model", status: "UNAVAILABLE", detail });
    result.summary = `HOLD: ${detail}`;
    return result;
  };
  const parsedContract = fnoInstrumentSchema.safeParse(analysis.instrument);
  if (analysis.segment !== "FNO" || mode === "CNC" || !parsedContract.success) return unavailable("A verified CE/PE contract in MIS or NRML is required.");
  const contract = parsedContract.data;
  const type = contract.instrumentType;
  const strike = contract.strikePrice;
  if (type === "FUT" || strike === null) return unavailable("Option-aware decisions apply to CE/PE options, not futures.");
  const expiryAt = Date.parse(`${contract.expiry}T15:30:00+05:30`);
  if (!freshOptionTimestamp(analysis.quote.lastTradeTime, now) || !Number.isFinite(analysis.quote.price) || analysis.quote.price <= 0) {
    return unavailable("A same-day option premium no older than 60 seconds is required, including for exit guidance.");
  }
  if (expiryAt <= now) return unavailable("The option has expired; no new pre-expiry verdict is available.");
  if (technical.decision === "SELL" && technical.dataReady) {
    result.decision = "SELL";
    result.exitOnly = true;
    result.summary = "SELL / EXIT OWNED OPTIONS ONLY: fresh bearish technical rules agree. Option-risk checks never block an exit or suggest uncovered writing.";
    result.checks.push({ label: "Technical direction", status: "PASS", detail: technical.summary });
    return result;
  }
  result.checks.push({ label: "Technical BUY", status: technical.decision === "BUY" ? "PASS" : "FAIL", detail: technical.summary });
  if (!input) return unavailable("Waiting for verified underlying and option model inputs.");
  let model: ReturnType<typeof calculateOptionAnalytics>;
  try {
    if (JSON.stringify(fnoInstrumentSchema.parse(input.instrument)) !== JSON.stringify(contract) ||
      input.premium !== analysis.quote.price || input.premiumTime !== analysis.quote.lastTradeTime) {
      return unavailable("The model inputs do not match this contract and current premium.");
    }
    // Verdicts concern a new purchase now, not a manually edited historical cost or position size.
    model = calculateOptionAnalytics({ ...input, now, entryPremium: analysis.quote.price, lots: 1 });
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : "The option model could not be calculated.");
  }
  const fits = Math.abs(model.price - analysis.quote.price) <= contract.tickSize;
  result.checks.push({ label: "IV / market consistency", status: fits ? "PASS" : "FAIL",
    detail: fits ? "Model premium matches current LTP within one contract tick."
      : "The IV override does not reproduce current premium within one tick. Clear it for a live-market verdict; hypothetical IV cannot manufacture a BUY." });
  const session = regularMarketSession(now);
  if (mode === "MIS" && (session.phase !== "open" || now >= intradayEntryCutoff(now))) {
    return unavailable("MIS entry guidance requires the regular session before 15:20 IST; existing exits remain available.");
  }
  result.horizonAt = Math.min(expiryAt, mode === "MIS" ? session.closesAt : now + 86400_000);
  const elapsedYears = (result.horizonAt - now) / (365 * 86400_000);
  const remainingYears = (expiryAt - result.horizonAt) / (365 * 86400_000);
  const volatility = model.ivPercent / 100;
  const direction = type === "CE" ? 1 : -1;
  const move = volatility * Math.sqrt(elapsedYears);
  const definitions = [
    { id: "favorable", label: "Delta / gamma: favorable 1-sigma spot", spot: input.spot * Math.exp(direction * move), ivPercent: model.ivPercent, ratePercent: input.ratePercent },
    { id: "adverse", label: "Delta / gamma: adverse 1-sigma spot", spot: input.spot * Math.exp(-direction * move), ivPercent: model.ivPercent, ratePercent: input.ratePercent },
    { id: "decay", label: "Theta: unchanged spot and IV", spot: input.spot, ivPercent: model.ivPercent, ratePercent: input.ratePercent },
    { id: "iv", label: "Vega: IV down 1 percentage point", spot: input.spot, ivPercent: Math.max(0.01, model.ivPercent - 1), ratePercent: input.ratePercent },
    { id: "rate", label: "Rho: adverse rate move of 1 percentage point", spot: input.spot, ivPercent: model.ivPercent, ratePercent: input.ratePercent - direction },
  ] satisfies Omit<OptionScenario, "premium">[];
  try {
    result.scenarios = definitions.map(scenario => ({
      ...scenario,
      premium: remainingYears === 0 ? Math.max(0, direction * (scenario.spot - strike))
        : blackScholes({ type, spot: scenario.spot, strike, years: remainingYears,
          volatility: scenario.ivPercent / 100, rate: scenario.ratePercent / 100, dividend: input.dividendPercent / 100 }).price,
    }));
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : "Holding-period option repricing failed.");
  }
  if (technical.decision !== "BUY" || result.stopLoss === null || result.target === null) {
    result.summary = `HOLD: technical BUY is not confirmed. ${technical.summary} Option scenarios cannot override missing or conflicting direction.`;
    return result;
  }
  for (const scenario of result.scenarios.filter(item => item.id !== "adverse")) {
    const targetCheck = scenario.id === "favorable";
    const passed = targetCheck ? scenario.premium >= result.target : scenario.premium > result.stopLoss;
    result.checks.push({ label: scenario.label, status: passed ? "PASS" : "FAIL",
      detail: targetCheck ? (passed ? "Modeled premium reaches technical target 1 within the selected horizon."
        : "Technical target 1 requires more than this favorable model move within the selected horizon.")
        : passed ? "Modeled premium stays above the technical stop."
          : "Time decay / sensitivity scenario reaches or crosses the technical stop despite unchanged spot." });
  }
  const failures = result.checks.filter(check => check.status !== "PASS");
  if (!failures.length) {
    result.decision = "BUY";
    result.summary = "BUY CANDIDATE: technical direction and all option-scenario checks pass. This is a conditional, unbacktested model assessment, not entry approval.";
  } else result.summary = `HOLD despite technical BUY: ${failures.map(check => `${check.label}: ${check.detail}`).join(" ")}`;
  return result;
}
