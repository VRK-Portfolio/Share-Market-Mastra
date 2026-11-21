import { parse } from "csv-parse/sync";
import { z } from "zod";
import { nifty100Schema, nifty100Source } from "./nifty100-schemas.ts";
import type { Nifty100 } from "./nifty100-schemas.ts";

let cache: Nifty100 | undefined;
let pending: Promise<Nifty100> | undefined;
const rowSchema = z.object({
  "Company Name": z.string(), Industry: z.string(), Symbol: z.string(),
  Series: z.literal("EQ"), "ISIN Code": z.string(),
});

export function parseNifty100Csv(csv: string, fetchedAt: string): Nifty100 {
  const rows = z.array(rowSchema).parse(parse(csv, { columns: true, bom: true, skip_empty_lines: true, trim: true }));
  return nifty100Schema.parse({
    index: "NIFTY 100", exchange: "NSE", source: nifty100Source, fetchedAt,
    stocks: rows.map(row => ({ symbol: row.Symbol, name: row["Company Name"], industry: row.Industry, isin: row["ISIN Code"] }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol)),
  });
}

export async function getNifty100(signal: AbortSignal): Promise<Nifty100> {
  signal.throwIfAborted();
  if (cache && Date.now() - Date.parse(cache.fetchedAt) >= 0 && Date.now() - Date.parse(cache.fetchedAt) < 3_600_000) return cache;
  if (!pending) pending = (async () => {
    try {
      const response = await fetch(nifty100Source, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`Official NIFTY 100 constituents returned HTTP ${response.status}.`);
      const csv = await response.text();
      if (csv.length > 200_000) throw new Error("The official NIFTY 100 constituent file exceeds the expected size.");
      const list = parseNifty100Csv(csv, new Date(Date.now()).toISOString());
      cache = list;
      return list;
    } finally { pending = undefined; }
  })();
  const list = await pending;
  signal.throwIfAborted();
  return list;
}
