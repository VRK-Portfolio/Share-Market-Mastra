import { z } from "zod";
import { nifty100Schema } from "../groww/nifty100-schemas.ts";
import type { Nifty100, Nifty100Stock } from "../groww/nifty100-schemas.ts";
import { prepareStockScreen } from "./stock-screener.ts";
import type { ScreenerMode, StockScreenResult } from "./stock-screener.ts";
import type { MarketAnalysis } from "./types.ts";

const entrySchema = z.object({ key: z.string(), symbol: z.string(), isin: z.string(), mode: z.enum(["MIS", "CNC"]), data: z.unknown() });
let opened: Promise<IDBDatabase> | undefined;

function database() {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is unavailable in this browser."));
  if (!opened) opened = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("stock-terminal-screener-v1", 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      request.result.createObjectStore("baselines", { keyPath: "key" });
      request.result.createObjectStore("meta");
    };
    request.onerror = () => reject(new Error("Browser screener cache could not be opened."));
    request.onblocked = () => { blocked = true; reject(new Error("Browser screener cache is blocked by another tab.")); };
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return; }
      request.result.onversionchange = () => { request.result.close(); opened = undefined; };
      resolve(request.result);
    };
  }).catch(error => { opened = undefined; throw error; });
  return opened;
}

function read<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Browser screener cache could not be read."));
  });
}

async function write(store: "baselines" | "meta", action: (store: IDBObjectStore) => void) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(store, "readwrite");
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(new Error("Browser screener cache could not be saved; storage may be full or disabled."));
    action(transaction.objectStore(store));
  });
}

export const screenerCache = {
  async universe(now: number): Promise<Nifty100 | null> {
    const db = await database();
    const value: unknown = await read(db.transaction("meta").objectStore("meta").get("nifty100"));
    if (value === undefined) return null;
    const data = nifty100Schema.parse(value);
    const age = now - Date.parse(data.fetchedAt);
    if (age < -5000) throw new Error("Cached index membership has a future timestamp.");
    return age < 3_600_000 ? data : null;
  },
  saveUniverse(data: Nifty100) { return write("meta", store => { store.put(data, "nifty100"); }); },
  async baselines(stocks: Nifty100Stock[], now: number) {
    const db = await database();
    const entries: unknown[] = await read(db.transaction("baselines").objectStore("baselines").getAll());
    const identities = new Map(stocks.map(stock => [stock.isin, stock.symbol]));
    const results: Record<string, StockScreenResult> = {};
    let invalid = 0;
    for (const value of entries) {
      const parsed = entrySchema.safeParse(value);
      if (!parsed.success) { invalid++; continue; }
      const entry = parsed.data;
      if (!identities.has(entry.isin)) continue;
      if (identities.get(entry.isin) !== entry.symbol || entry.key !== `${entry.isin}:${entry.mode}`) { invalid++; continue; }
      try {
        results[`${entry.symbol}:${entry.mode}`] = { data: prepareStockScreen(entry.data, entry.symbol, entry.mode, now), fromCache: true };
      } catch { invalid++; }
    }
    const keep = new Set(stocks.flatMap(stock => [`${stock.isin}:MIS`, `${stock.isin}:CNC`]));
    const keys = await read(db.transaction("baselines").objectStore("baselines").getAllKeys());
    await write("baselines", store => { for (const key of keys) if (typeof key !== "string" || !keep.has(key)) store.delete(key); });
    return { results, invalid };
  },
  save(stock: Nifty100Stock, mode: ScreenerMode, data: MarketAnalysis) {
    return write("baselines", store => {
      store.put({ key: `${stock.isin}:${mode}`, symbol: stock.symbol, isin: stock.isin, mode, data });
    });
  },
};
