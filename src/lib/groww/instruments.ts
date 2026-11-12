import { parse } from "csv-parse/sync";
import { z } from "zod";
import { fnoInstrumentSchema } from "./instrument-schemas.ts";
import type { FnoInstrument } from "./instrument-schemas.ts";
import { feedInstrumentSchema } from "./live-schemas.ts";
import { orderInstrumentSchema } from "./order-schemas.ts";

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
      const response = await fetch("https://growwapi-assets.groww.in/instruments/instrument.csv", {
        cache: "no-store", signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error("Unable to download Groww instrument catalog.");
      const records = parseRecords(await response.text());
      const instruments = parseFnoRecords(records);
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

export async function getFeedInstrument(symbol: string, exchange: "NSE" | "BSE", segment: "CASH" | "FNO", signal: AbortSignal) {
  const catalog = await getCatalog(signal);
  const record = catalog.records.find((row) => row.trading_symbol === symbol && row.exchange === exchange && row.segment === segment);
  if (!record || (segment === "FNO" && record.expiry_date < currentIstDate())) return null;
  return feedInstrumentSchema.parse({
    symbol, exchange, segment, exchangeToken: record.exchange_token, instrumentType: record.instrument_type,
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
