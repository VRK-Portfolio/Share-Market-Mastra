import { isMastraTimeoutError } from "@mastra/core/loop";
import { requireGrowwSession } from "../../../../lib/groww/client.ts";
import { marketAnalysisSchema } from "../../../../lib/groww/market-schemas.ts";
import { isSameOrigin, sessionResponseHeaders } from "../../../../lib/groww/session.ts";
import {
  recommendationForMode, recommendationRequestSchema, recommendationResponseSchema,
  stockAnalysisModel, stockAnalysisPrompt, indicatorSnapshot,
} from "../../../../lib/market/recommendation.ts";
import { stockAnalysisAgent } from "../../../../mastra/agents/stock-analysis-agent.ts";
import { GET as getMarketAnalysis } from "../analysis/route.ts";

export const maxDuration = 90;

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return Response.json({ error: "Cross-origin stock analysis requests are not allowed." }, { status: 403, headers: sessionResponseHeaders });
  }
  const session = requireGrowwSession(request);
  if (session instanceof Response) return session;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    console.error("Gemini stock analysis request contained unreadable JSON.");
    return Response.json({ error: "Send a valid JSON stock selection." }, { status: 400, headers: sessionResponseHeaders });
  }
  const selection = recommendationRequestSchema.safeParse(body);
  if (!selection.success) {
    return Response.json({ error: "Send a valid symbol, NSE/BSE exchange, candle interval and MIS/CNC mode." }, { status: 400, headers: sessionResponseHeaders });
  }
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() && !process.env.GOOGLE_API_KEY?.trim()) {
    console.error("Gemini stock analysis requires a server-side Google API key.");
    return Response.json({
      error: "Gemini is not configured. Set GOOGLE_GENERATIVE_AI_API_KEY (or GOOGLE_API_KEY) on the server and restart the app.",
    }, { status: 503, headers: sessionResponseHeaders });
  }
  const { symbol, exchange, interval, mode, segment } = selection.data;
  try {
    const url = new URL("/api/groww/analysis", request.url);
    url.search = new URLSearchParams({ symbol, exchange, interval, segment }).toString();
    const marketResponse = await getMarketAnalysis(new Request(url, {
      headers: { cookie: request.headers.get("cookie") ?? "" },
      signal: request.signal,
    }));
    if (!marketResponse.ok) return marketResponse;
    const analysis = marketAnalysisSchema.parse(await marketResponse.json());
    const outputSchema = recommendationForMode(mode, analysis.instrument?.instrumentType);
    const result = await stockAnalysisAgent.generate(stockAnalysisPrompt(analysis, mode), {
      structuredOutput: { schema: outputSchema, errorStrategy: "strict" },
      maxSteps: 1,
      modelSettings: { temperature: 0.2, maxOutputTokens: 4096, maxRetries: 0, timeout: { totalMs: 45_000 } },
      abortSignal: request.signal,
    });
    const plan = outputSchema.safeParse(result.object);
    if (!plan.success) {
      console.error("Gemini stock analysis returned invalid fields:", plan.error.issues.map(({ path, code }) => ({ path, code })));
      return Response.json({ error: "Gemini returned an invalid trade plan. Retry analysis; no orders were placed." }, { status: 502, headers: sessionResponseHeaders });
    }
    const snapshot = indicatorSnapshot(analysis);
    const values = { VWAP: snapshot.vwap, RSI: snapshot.rsi, ATR: snapshot.atr, EMA20: snapshot.ema20,
      EMA50: snapshot.ema50, MACD: snapshot.macd, SUPERTREND: snapshot.supertrend };
    if (plan.data.indicatorAssessments.some((item) => (values[item.indicator] === null) !== (item.signal === "UNAVAILABLE")) ||
      (Object.values(values).every((value) => value === null) && plan.data.decision !== "HOLD")) {
      console.error("Gemini indicator assessments did not match available indicator data.");
      return Response.json({ error: "Gemini returned inconsistent indicator evidence. Retry analysis; no orders were placed." }, { status: 502, headers: sessionResponseHeaders });
    }
    const { entryPrice, stopLoss, targetPrices } = plan.data;
    const recommendation = recommendationResponseSchema.parse({
      ...plan.data, symbol, exchange, interval, mode, segment, instrument: analysis.instrument, model: stockAnalysisModel,
      generatedAt: new Date().toISOString(), snapshotAt: analysis.fetchedAt,
      referencePrice: analysis.quote.price, lastTradeTime: analysis.quote.lastTradeTime,
      lastCandleTime: analysis.candles.at(-1)?.time ?? null,
      candleCount: analysis.candles.length, candleSampleCount: Math.min(120, analysis.candles.length),
      omittedCandles: analysis.omittedCandles ?? 0,
      indicatorSnapshot: snapshot,
      riskRewardRatio: entryPrice !== null && stopLoss !== null && targetPrices.length
        ? Math.abs(targetPrices[0] - entryPrice) / Math.abs(entryPrice - stopLoss) : null,
    });
    return Response.json(recommendation, { headers: sessionResponseHeaders });
  } catch (error) {
    const timeout = isMastraTimeoutError(error);
    console.error(timeout ? "Gemini stock analysis timed out." : "Gemini stock analysis failed; no orders were placed.");
    return Response.json({
      error: timeout ? "Gemini analysis timed out. Retry analysis; your market data is still available."
        : "Unable to generate a valid Gemini analysis. Check the server's Google API key, model access and quota, then retry. No orders were placed.",
    }, { status: timeout ? 504 : 502, headers: sessionResponseHeaders });
  }
}
