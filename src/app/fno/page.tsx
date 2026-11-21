import { Suspense } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { terminalSession } from "../../lib/auth/session";
import { Dashboard } from "../../components/dashboard/dashboard";
import { analysisLinkSchema } from "../../lib/market/analysis-link";

type FnoPageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

async function PrivateFnoPage({ searchParams }: FnoPageProps) {
  await connection();
  const cookieStore = await cookies();
  let session;
  try {
    session = await terminalSession(new Request("http://terminal.internal", {
      headers: { cookie: cookieStore.toString() },
    }));
  } catch {
    console.error("Terminal futures and options page access could not be verified.");
    return <p role="alert" className="p-6 text-sm text-negative">Terminal access could not be verified. Check server authentication and MongoDB availability, then reload.</p>;
  }
  if (!session) redirect("/login");
  const params = await searchParams;
  const selection = params.symbol === undefined && params.mode === undefined && params.exchange === undefined ? null
    : analysisLinkSchema.safeParse({ segment: "FNO", symbol: params.symbol, mode: params.mode, exchange: params.exchange });
  return <Dashboard terminalExpiresAt={session.expiresAt} segment="FNO"
    initialSelection={selection?.success ? selection.data : undefined}
    initialSelectionError={selection && !selection.success ? "Invalid contract analysis link. Choose a valid contract symbol, NSE/BSE exchange and MIS or NRML mode, or search below." : undefined} />;
}

export default function FnoPage(props: FnoPageProps) {
  return <Suspense fallback={<p className="p-6 text-sm text-muted">Verifying terminal access...</p>}><PrivateFnoPage {...props} /></Suspense>;
}
