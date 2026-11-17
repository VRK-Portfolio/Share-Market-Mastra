import { Dashboard } from "../components/dashboard/dashboard";
import { Suspense } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { terminalSession } from "../lib/auth/session";

async function PrivateTerminal() {
  await connection();
  const cookieStore = await cookies();
  let session;
  try {
    session = await terminalSession(new Request("http://terminal.internal", {
      headers: { cookie: cookieStore.toString() },
    }));
  } catch {
    console.error("Terminal page access could not be verified.");
    return <p role="alert" className="p-6 text-sm text-negative">Terminal access could not be verified. Check server authentication and MongoDB availability, then reload.</p>;
  }
  if (!session) redirect("/login");
  return <Dashboard terminalExpiresAt={session.expiresAt} />;
}
export default function Home() {
  return <Suspense fallback={<p className="p-6 text-sm text-muted">Verifying terminal access...</p>}><PrivateTerminal /></Suspense>;
}
