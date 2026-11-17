import { isMastraTimeoutError } from "@mastra/core/loop";
import { z } from "zod";
import { requireGrowwSession } from "../../../../lib/groww/client.ts";
import { InstrumentCatalogError, searchCashInstruments } from "../../../../lib/groww/instruments.ts";
import { stockSymbolSchema } from "../../../../lib/groww/instrument-schemas.ts";
import { isSameOrigin, sessionResponseHeaders } from "../../../../lib/groww/session.ts";
import { CompanyNewsError, fetchCompanyNews } from "../../../../lib/market/company-news.ts";
import { combineHeadlineClassifications, headlineBalance, newsClassificationSchema, newsSentimentSchema } from "../../../../lib/market/news-sentiment.ts";
import { stockAnalysisModel } from "../../../../lib/market/recommendation.ts";
import { newsSentimentAgent } from "../../../../mastra/agents/news-sentiment-agent.ts";

export const maxDuration = 90;
const selectionSchema = z.object({ symbol: stockSymbolSchema, exchange: z.enum(["NSE", "BSE"]) }).strict();
export async function POST(request: Request) {
  const reply = (body: object, status = 200) => Response.json(body, { status, headers: sessionResponseHeaders });
  if (!isSameOrigin(request)) return reply({ error: "Cross-origin sentiment requests are not allowed." }, 403);
  const session = requireGrowwSession(request);
  if (session instanceof Response) return session;
  let body: unknown;
  try { body = await request.json(); } catch {
    console.error("News sentiment request contained unreadable JSON.");
    return reply({ error: "Send a valid stock selection." }, 400);
  }
  const selection = selectionSchema.safeParse(body);
  if (!selection.success) return reply({ error: "Select a CASH stock symbol and NSE/BSE exchange." }, 400);
  const apiKey = process.env.GNEWS_API_KEY?.trim();
  if (!apiKey) return reply({ error: "News is not configured. Set GNEWS_API_KEY on the server and restart the app." }, 503);
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() && !process.env.GOOGLE_API_KEY?.trim()) {
    return reply({ error: "Sentiment classification requires GOOGLE_GENERATIVE_AI_API_KEY (or GOOGLE_API_KEY) on the server." }, 503);
  }
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(85_000)]);
  try {
    const { symbol, exchange } = selection.data;
    const instruments = await searchCashInstruments(symbol, exchange, signal);
    const instrument = instruments.find((item) => item.tradingSymbol === symbol);
    if (!instrument) return reply({ error: "This symbol is not a verified CASH equity in the Groww catalogue." }, 404);
    const companyName = (instrument.name ?? symbol).slice(0, 200);
    const news = await fetchCompanyNews(symbol, companyName, apiKey, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
    let articles: ReturnType<typeof combineHeadlineClassifications> = [];
    if (news.articles.length) {
      const result = await newsSentimentAgent.generate(JSON.stringify({
        symbol, exchange, companyName,
        headlines: news.articles.map(({ id, title, source, publishedAt }) => ({ id, title, source, publishedAt })),
      }), {
        structuredOutput: { schema: newsClassificationSchema, errorStrategy: "strict" }, maxSteps: 1,
        modelSettings: { temperature: 0, maxOutputTokens: 2048, maxRetries: 0, timeout: { totalMs: 30_000 } },
        abortSignal: signal,
      });
      articles = combineHeadlineClassifications(news.articles, result.object);
    }
    return reply(newsSentimentSchema.parse({
      symbol, exchange, companyName, provider: "GNews", model: articles.length ? stockAnalysisModel : null,
      fetchedAt: news.fetchedAt, articles, bias: headlineBalance(articles).bias,
    }));
  } catch (error) {
    const timeout = signal.aborted || isMastraTimeoutError(error) || error instanceof DOMException && error.name === "TimeoutError";
    console.error(timeout ? "Company news sentiment timed out." : "Company news sentiment failed.");
    return reply({ error: error instanceof CompanyNewsError || error instanceof InstrumentCatalogError ? error.message
      : timeout ? "News sentiment timed out. Refresh it manually; no trade rules or orders changed."
        : "Unable to retrieve or validate company news sentiment. Check news/model access and quota, then retry." },
    error instanceof CompanyNewsError ? error.status : timeout ? 504 : 502);
  }
}
