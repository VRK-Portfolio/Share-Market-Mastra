import { fetchPortfolio } from "../../../../lib/groww/portfolio.ts";

export async function GET(request: Request) {
  return fetchPortfolio(request, "holdings");
}
