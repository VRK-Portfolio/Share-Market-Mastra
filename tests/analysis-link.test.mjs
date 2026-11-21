import assert from "node:assert/strict";
import { test } from "node:test";
import { analysisLinkSchema, analysisLinkUrl } from "../src/lib/market/analysis-link.ts";

test("cash and contract URLs round-trip exact symbols, exchange and holding period", () => {
  for (const selection of [
    { segment: "CASH", symbol: "M&M", exchange: "BSE", mode: "CNC" },
    { segment: "CASH", symbol: "RELIANCE", exchange: "NSE", mode: "MIS" },
    { segment: "FNO", symbol: "NIFTY99NOV25000PE", exchange: "NSE", mode: "NRML" },
    { segment: "FNO", symbol: "SENSEX99NOVFUT", exchange: "BSE", mode: "MIS" },
  ]) {
    const path = selection.segment === "FNO" ? "/fno" : "/";
    const result = analysisLinkUrl(`https://terminal.test${path}?view=chart&symbol=OLD&symbol=STALE#market-workspace`, selection);
    const url = new URL(result, "https://terminal.test");
    assert.equal(url.pathname, path);
    assert.equal(url.searchParams.get("view"), "chart");
    assert.equal(url.hash, "#market-workspace");
    assert.deepEqual(url.searchParams.getAll("symbol"), [selection.symbol]);
    assert.deepEqual(analysisLinkSchema.parse({ ...Object.fromEntries(url.searchParams), segment: selection.segment }), selection);
  }
});

test("clearing a selection removes stale link parameters, preserving unrelated URL state", () => {
  const href = analysisLinkUrl("https://terminal.test/fno?symbol=OLD&mode=NRML&exchange=BSE&view=chart#market-workspace",
    { segment: "FNO", symbol: "", mode: "MIS", exchange: "NSE" });
  assert.equal(href, "/fno?view=chart#market-workspace");
});

test("links preserve legacy cash defaults and reject invalid exchanges, repeated parameters and incompatible modes", () => {
  assert.deepEqual(analysisLinkSchema.parse({ segment: "CASH", symbol: "reliance" }),
    { segment: "CASH", symbol: "RELIANCE", exchange: "NSE", mode: "MIS" });
  const cash = { segment: "CASH", symbol: "M&M", exchange: "BSE", mode: "CNC" };
  const fno = { segment: "FNO", symbol: "NIFTY99NOV25000PE", exchange: "NSE", mode: "NRML" };
  for (const selection of [
    { ...cash, exchange: "INVALID" }, { ...cash, symbol: ["TCS", "RELIANCE"] },
    { ...cash, exchange: ["NSE", "BSE"] }, { ...cash, mode: "NRML" },
    { ...cash, symbol: "NSE:ABC" }, { ...fno, mode: "CNC" }, { ...fno, symbol: "" },
  ]) assert.equal(analysisLinkSchema.safeParse(selection).success, false);
});
