export const paperCostModel = {
  id: "ESTIMATED_V1" as const,
  feeRate: 0.001,
  slippageRate: 0.0005,
};

export function paperEstimatedFees(notional: number) {
  if (!Number.isSafeInteger(notional) || notional <= 0) throw new Error("Paper fee value cannot be represented safely.");
  return Math.ceil(notional * paperCostModel.feeRate);
}

export function paperExecutionPrice(price: number, side: "BUY" | "SELL", tickSize = 0.01, limitPrice?: number) {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(tickSize) || tickSize <= 0) {
    throw new Error("A positive paper execution price and tick size are required.");
  }
  const slipped = price * (1 + (side === "BUY" ? 1 : -1) * paperCostModel.slippageRate);
  const ticks = side === "BUY" ? Math.ceil(slipped / tickSize - 1e-9) : Math.floor(slipped / tickSize + 1e-9);
  const result = Number((ticks * tickSize).toFixed(8));
  const capped = limitPrice === undefined ? result : side === "BUY" ? Math.min(result, limitPrice) : Math.max(result, limitPrice);
  if (!Number.isFinite(capped) || capped <= 0 || !Number.isSafeInteger(Math.round(capped * 100))) {
    throw new Error("Paper execution price cannot be represented safely.");
  }
  return capped;
}

export function paperPlannedRisk(quantity: number, entry: number, stop: number, side: "BUY" | "SELL", tickSize = 0.01) {
  const exitSide = side === "BUY" ? "SELL" : "BUY";
  const exit = paperExecutionPrice(stop, exitSide, tickSize);
  const notional = Math.round(entry * 100) * quantity;
  const exitNotional = Math.round(exit * 100) * quantity;
  const distance = Math.max(0, (side === "BUY" ? 1 : -1) * (notional - exitNotional));
  return distance + paperEstimatedFees(notional) + paperEstimatedFees(exitNotional);
}
