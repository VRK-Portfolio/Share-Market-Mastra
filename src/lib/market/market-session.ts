export function regularMarketSession(now: number) {
  const ist = new Date(now + 330 * 60_000);
  const date = ist.toISOString().slice(0, 10);
  const opensAt = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 9, 15) - 330 * 60_000;
  const closesAt = opensAt + (6 * 60 + 15) * 60_000;
  const phase = ist.getUTCDay() === 0 || ist.getUTCDay() === 6 ? "weekend"
    : now < opensAt ? "before-open" : now >= closesAt ? "after-close" : "open";
  return { date, phase, opensAt, closesAt };
}

export const intradayEntryCutoff = (now: number) => regularMarketSession(now).closesAt - 10 * 60_000;
