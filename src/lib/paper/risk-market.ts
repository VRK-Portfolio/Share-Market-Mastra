import { growwJson } from "../groww/client.ts";
import { growwFnoQuoteSchema, growwQuoteSchema } from "../groww/market-schemas.ts";
import { paperPriceKey, paperSegment } from "../market/paper-instruments.ts";
import type { PaperAccount, PaperLivePrice } from "../market/paper-trading.ts";
import type { PaperRiskPrices } from "../market/paper-risk.ts";

export const paperRiskMarket = {
  async load(token: string, account: PaperAccount, signal: AbortSignal, seed?: PaperLivePrice) {
    const prices: PaperRiskPrices = seed ? { [paperPriceKey(seed)]: seed } : {};
    const selections = [...new Map(account.positions.map(position => [paperPriceKey(position), position])).values()]
      .filter(position => !prices[paperPriceKey(position)]);
    const results = await Promise.allSettled(selections.map(async position => {
      const url = new URL("https://api.groww.in/v1/live-data/quote");
      const segment = paperSegment(position);
      url.search = new URLSearchParams({ trading_symbol: position.symbol, exchange: position.exchange, segment }).toString();
      const quote = (segment === "FNO" ? growwFnoQuoteSchema : growwQuoteSchema).parse(await growwJson(url, token, "paper risk quote", signal));
      if (quote.lastTradeTime === null) throw new Error("Risk quote has no trade timestamp.");
      const observedAt = Date.now();
      return { type: "tick" as const, symbol: position.symbol, exchange: position.exchange, segment,
        price: quote.price, tradeTime: quote.lastTradeTime, receivedAt: new Date(observedAt).toISOString(), observedAt };
    }));
    let failed = 0;
    for (const result of results) {
      if (result.status === "fulfilled") prices[paperPriceKey(result.value)] = result.value;
      else failed++;
    }
    if (failed) console.error("Paper risk valuation is incomplete; new entries will be blocked.", { failed });
    return prices;
  },
};
