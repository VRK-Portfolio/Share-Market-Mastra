import { z } from "zod";
import { stockSymbolSchema } from "../groww/instrument-schemas.ts";
import { calculateTechnicalVerdict } from "./technical-verdict.ts";
import type { ShortTermScenarios } from "./short-term-scenarios.ts";
import type { MarketAnalysis } from "./types.ts";

export const scenarioAlertsStorageKey = "trade-terminal:scenario-alerts:v1";
const positive = z.number().finite().positive();
const instrumentFields = {
  symbol: stockSymbolSchema,
  exchange: z.enum(["NSE", "BSE"]),
  segment: z.enum(["CASH", "FNO"]),
  growwSymbol: z.string().min(1).nullable(),
};
const completionSchema = z.object({
  reason: z.enum(["TIME", "PRICE"]),
  completedAt: z.iso.datetime(),
  price: positive.nullable(),
  boundary: z.enum(["LOWER", "UPPER"]).nullable(),
  tradeTime: z.number().int().positive().nullable(),
}).refine((value) => value.reason === "TIME"
  ? value.price === null && value.boundary === null && value.tradeTime === null
  : value.price !== null && value.boundary !== null && value.tradeTime !== null,
"Completion details must match the notification reason.");
export const scenarioAlertSchema = z.object({
  ...instrumentFields,
  id: z.uuid(),
  minutes: z.union([z.literal(15), z.literal(30)]),
  bias: z.enum(["BULLISH", "BEARISH", "NEUTRAL"]),
  referencePrice: positive,
  atr: positive,
  lowerPrice: positive,
  upperPrice: positive,
  snapshotAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  completion: completionSchema.nullable(),
  acknowledged: z.boolean(),
}).refine((alert) =>
  (alert.segment === "CASH" ? alert.growwSymbol === null : alert.growwSymbol !== null) &&
  alert.lowerPrice < alert.referencePrice && alert.referencePrice < alert.upperPrice &&
  Date.parse(alert.endsAt) > Date.parse(alert.createdAt) &&
  Date.parse(alert.endsAt) <= Date.parse(alert.createdAt) + alert.minutes * 60_000 &&
  Date.parse(alert.snapshotAt) <= Date.parse(alert.createdAt) + 5000 &&
  (alert.completion !== null || !alert.acknowledged),
"Saved alert identity, bounds and timestamps must be consistent.");
const storedAlertsSchema = z.object({ version: z.literal(1), alerts: z.array(scenarioAlertSchema) })
  .refine((value) => new Set(value.alerts.map((alert) => alert.id)).size === value.alerts.length,
    "Saved alert IDs must be unique.");
export type ScenarioAlert = z.infer<typeof scenarioAlertSchema>;
export type ScenarioInstrument = Pick<ScenarioAlert, "symbol" | "exchange" | "segment" | "growwSymbol">;
export type ScenarioPriceObservation = ScenarioInstrument & { price: number; tradeTime: number };

export function scenarioInstrument(analysis: MarketAnalysis): ScenarioInstrument {
  return {
    symbol: analysis.symbol, exchange: analysis.exchange, segment: analysis.segment ?? "CASH",
    growwSymbol: analysis.instrument?.growwSymbol ?? null,
  };
}

export function createScenarioAlerts(
  analysis: MarketAnalysis, scenarios: ShortTermScenarios, now = Date.now(),
  id = () => crypto.randomUUID(),
): ScenarioAlert[] {
  if (!scenarios.available || analysis.interval !== "15minute" ||
    !calculateTechnicalVerdict(analysis, "MIS", now).dataReady ||
    scenarios.snapshotAt !== analysis.fetchedAt || scenarios.referencePrice !== analysis.quote.price ||
    scenarios.atr !== analysis.technical.atr) {
    throw new Error("Save requires fresh 15-minute data matching the displayed scenario snapshot. Refresh market data and try again.");
  }
  const alerts = scenarios.rows.flatMap((row): ScenarioAlert[] => row.available ? [scenarioAlertSchema.parse({
    ...scenarioInstrument(analysis), id: id(), minutes: row.minutes, bias: scenarios.bias,
    referencePrice: scenarios.referencePrice, atr: scenarios.atr,
    lowerPrice: row.lowerPrice, upperPrice: row.upperPrice,
    snapshotAt: scenarios.snapshotAt, createdAt: new Date(now).toISOString(), endsAt: row.endsAt,
    completion: null, acknowledged: false,
  })] : []);
  if (!alerts.length) throw new Error("No available 15- or 30-minute horizon can be saved.");
  return alerts;
}

function sameInstrument(a: ScenarioInstrument, b: ScenarioInstrument) {
  return a.symbol === b.symbol && a.exchange === b.exchange && a.segment === b.segment && a.growwSymbol === b.growwSymbol;
}

export function mergeScenarioAlerts(existing: ScenarioAlert[], candidates: ScenarioAlert[]): ScenarioAlert[] {
  const added = candidates.filter((candidate) => !existing.some((alert) =>
    sameInstrument(alert, candidate) && alert.minutes === candidate.minutes &&
    alert.snapshotAt === candidate.snapshotAt && alert.endsAt === candidate.endsAt &&
    alert.referencePrice === candidate.referencePrice && alert.atr === candidate.atr &&
    alert.bias === candidate.bias && alert.lowerPrice === candidate.lowerPrice && alert.upperPrice === candidate.upperPrice));
  return added.length ? [...existing, ...added] : existing;
}

export function completeScenarioAlerts(
  alerts: ScenarioAlert[], now = Date.now(), observation?: ScenarioPriceObservation,
): ScenarioAlert[] {
  const fresh = observation && Number.isFinite(observation.price) && observation.price > 0 &&
    Number.isSafeInteger(observation.tradeTime) &&
    now - observation.tradeTime >= -5000 && now - observation.tradeTime <= 60_000;
  let changed = false;
  const next = alerts.map((alert): ScenarioAlert => {
    if (alert.completion) return alert;
    let completion: ScenarioAlert["completion"] = null;
    // A late observation cannot retroactively replace a deadline notification.
    if (now >= Date.parse(alert.endsAt)) {
      completion = { reason: "TIME", completedAt: new Date(now).toISOString(), price: null, boundary: null, tradeTime: null };
    } else if (fresh && observation && sameInstrument(alert, observation) &&
      observation.tradeTime >= Date.parse(alert.createdAt)) {
      const upper = alert.bias !== "BEARISH" && observation.price >= alert.upperPrice;
      const lower = alert.bias !== "BULLISH" && observation.price <= alert.lowerPrice;
      if (upper || lower) completion = {
        reason: "PRICE", completedAt: new Date(now).toISOString(), price: observation.price,
        boundary: upper ? "UPPER" : "LOWER", tradeTime: observation.tradeTime,
      };
    }
    if (!completion) return alert;
    changed = true;
    return { ...alert, completion };
  });
  return changed ? next : alerts;
}

export function updateStoredScenarioAlerts(
  storage: Pick<Storage, "getItem" | "setItem">,
  update: (alerts: ScenarioAlert[]) => ScenarioAlert[],
): ScenarioAlert[] {
  const raw = storage.getItem(scenarioAlertsStorageKey);
  let alerts: ScenarioAlert[] = [];
  if (raw !== null) {
    let value: unknown;
    try { value = JSON.parse(raw); } catch {
      throw new Error("Saved scenario alerts contain invalid JSON. They were not overwritten; clear saved alerts or restore valid data.");
    }
    const parsed = storedAlertsSchema.safeParse(value);
    if (!parsed.success) throw new Error("Saved scenario alerts have an unsupported or invalid format. They were not overwritten; clear saved alerts or restore valid data.");
    alerts = parsed.data.alerts;
  }
  const next = update(alerts);
  if (next !== alerts) {
    const validated = storedAlertsSchema.parse({ version: 1, alerts: next });
    storage.setItem(scenarioAlertsStorageKey, JSON.stringify(validated));
    return validated.alerts;
  }
  return alerts;
}
