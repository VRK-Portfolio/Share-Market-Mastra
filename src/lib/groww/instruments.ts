import { parse } from "csv-parse/sync";
import { z } from "zod";
import { cashInstrumentSchema, fnoInstrumentSchema } from "./instrument-schemas.ts";
import type { FnoInstrument } from "./instrument-schemas.ts";
import { feedInstrumentSchema } from "./live-schemas.ts";
import { orderInstrumentSchema } from "./order-schemas.ts";
import { indexInstrumentSchema } from "./benchmark-schemas.ts";
import { feedSelectionSchema } from "./live-schemas.ts";
import type { PortfolioInstrumentSelection } from "./portfolio-instrument-schemas.ts";
import { optionUnderlyingInstrumentSchema } from "./option-analytics-schemas.ts";

export const optionIndexAliases: Record<string, string> = { MIDCPNIFTY: "NIFTYMIDSELECT", NIFTYNXT50: "NIFTYJR" };

const decimal = z.string().regex(/^\d+(?:\.\d+)?$/).transform(Number).pipe(z.number().finite());
const strike = z.string().regex(/^-?\d+(?:\.\d+)?$/).transform(Number).pipe(z.number().finite());
const rowSchema = z.object({
  exchange: z.enum(["NSE", "BSE"]), trading_symbol: z.string(), groww_symbol: z.string(),
  underlying_symbol: z.string(), instrument_type: z.enum(["FUT", "CE", "PE"]),
  expiry_date: z.iso.date(), strike_price: z.union([z.literal(""), strike]),
  lot_size: decimal.pipe(z.number().int().positive()), tick_size: decimal.pipe(z.number().positive()),
});
const requiredColumns = Object.keys(rowSchema.shape).concat("segment");
type Catalog = { instruments: FnoInstrument[]; records: Record<string, string>[] };
let cache: Catalog & { expiresAt: number } | undefined;
let pending: Promise<Catalog> | undefined;

export class InstrumentCatalogError extends Error {
  readonly stage: "catalog download" | "catalog validation";
  readonly failureType: "timeout" | "http" | "network" | "invalid-catalog";
  readonly upstreamStatus?: number;

  constructor(failureType: InstrumentCatalogError["failureType"], upstreamStatus?: number) {
    super(failureType === "timeout" ? "Groww's instrument catalog download timed out. Retry the stock or contract search."
      : failureType === "invalid-catalog" ? "Groww returned an invalid instrument catalog. Retry the stock or contract search."
      : "Unable to download Groww's instrument catalog. Check the server's network connection and retry the search.");
    this.stage = failureType === "invalid-catalog" ? "catalog validation" : "catalog download";
    this.failureType = failureType;
    this.upstreamStatus = upstreamStatus;
  }
}

function parseRecords(csv: string) {
  const rows: unknown = parse(csv, {
    bom: true, skip_empty_lines: true,
    columns: (columns: string[]) => {
      if (!requiredColumns.every((name) => columns.includes(name))) throw new Error("Missing instrument CSV columns.");
      return columns;
    },
  });
  return z.array(z.record(z.string(), z.string())).parse(rows);
}

function parseFnoRecords(records: Record<string, string>[]) {
  return records.filter((record) => record.segment === "FNO").map((record) => {
    const row = rowSchema.parse(record);
    return fnoInstrumentSchema.parse({
      exchange: row.exchange, tradingSymbol: row.trading_symbol, growwSymbol: row.groww_symbol,
      underlying: row.underlying_symbol, instrumentType: row.instrument_type, expiry: row.expiry_date,
      strikePrice: row.instrument_type === "FUT" ? null : row.strike_price === "" ? null : row.strike_price,
      lotSize: row.lot_size, tickSize: row.tick_size,
    });
  });
}

export function parseInstrumentCsv(csv: string): FnoInstrument[] {
  return parseFnoRecords(parseRecords(csv));
}

export function currentIstDate() {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

async function getCatalog(signal: AbortSignal): Promise<Catalog> {
  signal.throwIfAborted();
  if (cache && cache.expiresAt > Date.now()) return cache;
  if (!pending) {
    pending = (async () => {
      const downloadSignal = AbortSignal.timeout(45_000);
      let csv: string;
      try {
        const response = await fetch("https://growwapi-assets.groww.in/instruments/instrument.csv", {
          cache: "no-store", signal: downloadSignal,
        });
        if (!response.ok) throw new InstrumentCatalogError("http", response.status);
        csv = await response.text();
      } catch (error) {
        if (error instanceof InstrumentCatalogError) throw error;
        throw new InstrumentCatalogError(downloadSignal.aborted ||
          error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "network");
      }
      let records: Catalog["records"];
      let instruments: Catalog["instruments"];
      try {
        records = parseRecords(csv);
        instruments = parseFnoRecords(records);
      } catch {
        throw new InstrumentCatalogError("invalid-catalog");
      }
      cache = { instruments, records, expiresAt: Date.now() + 3_600_000 };
      return cache;
    })();
  }

  const loading = pending;
  try {
    const instruments = await loading;
    signal.throwIfAborted();
    return instruments;
  } finally {
    if (pending === loading) pending = undefined;
  }
}

export async function getFnoInstruments(signal: AbortSignal): Promise<FnoInstrument[]> {
  return (await getCatalog(signal)).instruments;
}

function optionUnderlyingRows(records: Catalog["records"], exchange: "NSE" | "BSE") {
  const rows = new Map<string, Map<string, Catalog["records"][number]>>();
  for (const row of records) {
    if (row.exchange !== exchange || row.segment !== "CASH" || !["EQ", "IDX"].includes(row.instrument_type)) continue;
    const matches = rows.get(row.trading_symbol) ?? new Map<string, Catalog["records"][number]>();
    matches.set(row.groww_symbol, row);
    rows.set(row.trading_symbol, matches);
  }
  return rows;
}

function resolveOptionUnderlying(rows: ReturnType<typeof optionUnderlyingRows>, underlying: string) {
  const matches = rows.get(optionIndexAliases[underlying] ?? underlying);
  if (matches?.size !== 1) return null;
  const row = [...matches.values()][0];
  return optionUnderlyingInstrumentSchema.parse({
    exchange: row.exchange, tradingSymbol: row.trading_symbol, growwSymbol: row.groww_symbol,
    name: row.name?.trim() || null, instrumentType: row.instrument_type,
  });
}

export async function getOptionUnderlyingInstrument(contract: FnoInstrument, signal: AbortSignal) {
  return resolveOptionUnderlying(optionUnderlyingRows((await getCatalog(signal)).records, contract.exchange), contract.underlying);
}

export async function getOptionGuideUnderlyings(exchange: "NSE" | "BSE", signal: AbortSignal) {
  const catalog = await getCatalog(signal);
  const rows = optionUnderlyingRows(catalog.records, exchange);
  const underlyings = new Set(catalog.instruments.filter(item => item.exchange === exchange &&
    item.expiry >= currentIstDate() && item.instrumentType !== "FUT").map(item => item.underlying));
  return [...underlyings].flatMap(underlying => {
    const index = resolveOptionUnderlying(rows, underlying);
    return index ? [{ underlying, index }] : [];
  }).sort((a, b) => Number(b.underlying === "NIFTY") - Number(a.underlying === "NIFTY") ||
    Number(b.index.instrumentType === "IDX") - Number(a.index.instrumentType === "IDX") ||
    a.underlying.localeCompare(b.underlying));
}

export async function getIndexInstruments(exchange: "NSE" | "BSE", signal: AbortSignal) {
  const records = (await getCatalog(signal)).records;
  return records.filter((row) => row.segment === "CASH" && row.instrument_type === "IDX" && row.exchange === exchange)
    .map((row) => indexInstrumentSchema.parse({
      exchange: row.exchange, tradingSymbol: row.trading_symbol, growwSymbol: row.groww_symbol,
      name: row.name?.trim() || null, instrumentType: row.instrument_type,
    }))
    .sort((a, b) => a.tradingSymbol.localeCompare(b.tradingSymbol));
}

export async function searchCashInstruments(q: string, exchange: "NSE" | "BSE", signal: AbortSignal) {
  const query = q.trim().toUpperCase();
  const records = (await getCatalog(signal)).records;
  const seen = new Set<string>();
  return records.filter((row) => row.segment === "CASH" && row.instrument_type === "EQ" && row.exchange === exchange)
    .flatMap((row) => {
      const symbol = row.trading_symbol.toUpperCase();
      const name = (row.name ?? "").trim().toUpperCase();
      if (seen.has(symbol) || ![symbol, name].some((value) => value.includes(query))) return [];
      seen.add(symbol);
      const parsed = cashInstrumentSchema.safeParse({
        exchange: row.exchange, tradingSymbol: row.trading_symbol, growwSymbol: row.groww_symbol,
        name: row.name?.trim() || null,
      });
      if (!parsed.success) throw new InstrumentCatalogError("invalid-catalog");
      const instrument = parsed.data;
      const rank = symbol === query ? 0 : name === query ? 1 : symbol.startsWith(query) ? 2 : name.startsWith(query) ? 3 : 4;
      return [{ instrument, rank }];
    })
    .sort((a, b) => a.rank - b.rank || a.instrument.tradingSymbol.localeCompare(b.instrument.tradingSymbol))
    .map(({ instrument }) => instrument);
}

export async function getFeedInstrument(symbol: string, exchange: "NSE" | "BSE", segment: "CASH" | "FNO", signal: AbortSignal) {
  const catalog = await getCatalog(signal);
  const record = catalog.records.find((row) => row.trading_symbol === symbol && row.exchange === exchange && row.segment === segment);
  if (!record || (segment === "FNO" && record.expiry_date < currentIstDate())) return null;
  return feedInstrumentSchema.parse({
    symbol, exchange, segment, exchangeToken: record.exchange_token, instrumentType: record.instrument_type,
  });
}

export async function getPortfolioInstruments(selections: PortfolioInstrumentSelection[], signal: AbortSignal) {
  const { records } = await getCatalog(signal);
  return selections.map(selection => {
    const symbol = selection.symbol.toUpperCase();
    const exchange = selection.exchange?.toUpperCase();
    const segment = selection.isin ? "CASH" : selection.segment?.toUpperCase();
    let candidates = records.filter(row => (!exchange || row.exchange === exchange) &&
      (!segment || row.segment === segment) &&
      (row.segment === "CASH" ? row.instrument_type === "EQ" : row.expiry_date >= currentIstDate()) &&
      (selection.isin && row.isin ? row.isin === selection.isin : row.trading_symbol === symbol));
    if (selection.isin && !exchange) {
      const preferred = candidates.some(row => row.exchange === "NSE") ? "NSE" : "BSE";
      candidates = candidates.filter(row => row.exchange === preferred);
    }
    const unique = [...new Map(candidates.map(row => [`${row.exchange}:${row.segment}:${row.trading_symbol}`, row])).values()];
    const match = unique.length === 1 ? unique[0] : null;
    const parsed = match ? feedSelectionSchema.safeParse({ symbol: match.trading_symbol, exchange: match.exchange, segment: match.segment }) : null;
    return parsed?.success
      ? { selection, instrument: parsed.data, error: null }
      : { selection, instrument: null, error: unique.length > 1
        ? "The portfolio instrument is ambiguous in Groww's catalog; a live valuation is unavailable."
        : "No supported, unexpired portfolio instrument was found in Groww's catalog." };
  });
}

export async function getOrderInstrument(symbol: string, exchange: "NSE" | "BSE", segment: "CASH" | "FNO", signal: AbortSignal) {
  const catalog = await getCatalog(signal);
  const record = catalog.records.find((row) => row.trading_symbol === symbol && row.exchange === exchange && row.segment === segment);
  if (!record || record.instrument_type === "IDX" || (segment === "FNO" && record.expiry_date < currentIstDate())) return null;
  return orderInstrumentSchema.parse({
    symbol, exchange, segment, instrumentType: record.instrument_type,
    lotSize: Number(record.lot_size), tickSize: Number(record.tick_size),
    expiry: segment === "FNO" ? record.expiry_date : null,
  });
}
