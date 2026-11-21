import { growwJson } from "./client.ts";
import { historicalRequests } from "./historical-requests.ts";
import { growwClosedCandleHistorySchema } from "./market-schemas.ts";
import { assessPaperEntry } from "../market/paper-entry-quality.ts";
import { paperSegment } from "../market/paper-instruments.ts";
import type { PaperAccount } from "../market/paper-trading.ts";

export async function loadPaperEntryQuality(token: string, entry: PaperAccount["fills"][number], signal: AbortSignal) {
  const segment = paperSegment(entry);
  const load = async (interval: "15minute" | "1day", days: number) => {
    const end = Math.floor(entry.at / 1000);
    const url = new URL("https://api.groww.in/v1/historical/candles");
    url.search = new URLSearchParams({
      exchange: entry.exchange, segment,
      groww_symbol: entry.instrument?.growwSymbol ?? `${entry.exchange}-${entry.symbol}`,
      start_time: String(end - days * 86400), end_time: String(end), candle_interval: interval,
    }).toString();
    const raw = await historicalRequests.run(token, signal, () => growwJson(url, token, "historical candles", signal));
    return growwClosedCandleHistorySchema(segment === "FNO", interval, entry.at).parse(raw);
  };
  const [intraday, daily] = await Promise.all([load("15minute", 14), load("1day", 90)]);
  return assessPaperEntry(entry, { intraday, daily });
}
