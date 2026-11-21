import { paperChargeLabels } from "../../lib/market/paper-costs";
import type { PaperCharges } from "../../lib/market/paper-costs";
import { feeNames } from "../../lib/market/trade-calculator";
import { money } from "./format";

export function PaperChargeBreakdown({ charges }: { charges: PaperCharges }) {
  return <dl className="paper-metrics mt-3 text-xs" aria-label="Paper charges breakdown">
    {feeNames.map(name => <div key={name}><dt className="text-muted">{paperChargeLabels[name]}</dt>
      <dd className="font-mono">{money(charges[name] / 100)}</dd></div>)}
    <div className="border-t border-line pt-2 font-semibold"><dt>Total charges</dt><dd>{money(charges.total / 100)}</dd></div>
  </dl>;
}
