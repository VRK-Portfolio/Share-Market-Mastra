import { z } from "zod";
import { stockSymbolSchema } from "../groww/instrument-schemas.ts";

export const newsLookbackHours = 72;
export const newsReceiptMaxAge = 15 * 60_000;
export const newsHeadlineMaxAge = 6 * 60 * 60_000;
const webUrl = z.url().max(2048).refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
}, "News links must be HTTPS without credentials.");
export const newsArticleSchema = z.object({
  id: z.string().regex(/^h[1-8]$/), title: z.string().trim().min(1).max(500), url: webUrl,
  source: z.string().trim().min(1).max(150), publishedAt: z.iso.datetime({ offset: true }),
});
const classificationSchema = z.object({
  id: newsArticleSchema.shape.id, relevant: z.boolean(),
  tone: z.enum(["POSITIVE", "NEGATIVE", "NEUTRAL"]),
  explanation: z.string().trim().min(1).max(240),
}).refine((item) => item.relevant || item.tone === "NEUTRAL", "Irrelevant news cannot have a directional tone.");
export const newsClassificationSchema = z.object({ headlines: z.array(classificationSchema).min(1).max(8) });
const assessedArticleSchema = newsArticleSchema.extend(classificationSchema.shape);
export function headlineBalance(articles: { relevant: boolean; tone: "POSITIVE" | "NEGATIVE" | "NEUTRAL" }[]) {
  const relevant = articles.filter((article) => article.relevant);
  const positive = relevant.filter((article) => article.tone === "POSITIVE").length;
  const negative = relevant.filter((article) => article.tone === "NEGATIVE").length;
  const neutral = relevant.length - positive - negative;
  const balance = relevant.length ? (positive - negative) / relevant.length : 0;
  const bias = relevant.length < 2 ? "UNAVAILABLE" : balance >= 0.25 ? "BULLISH" : balance <= -0.25 ? "BEARISH" : "NEUTRAL";
  return { positive, negative, neutral, relevant: relevant.length, bias };
}
export const newsSentimentSchema = z.object({
  symbol: stockSymbolSchema, exchange: z.enum(["NSE", "BSE"]), companyName: z.string().min(1).max(200),
  fetchedAt: z.iso.datetime(), provider: z.literal("GNews"), model: z.string().min(1).nullable(),
  articles: z.array(assessedArticleSchema).max(8),
  bias: z.enum(["BULLISH", "BEARISH", "NEUTRAL", "UNAVAILABLE"]),
}).superRefine((snapshot, context) => {
  const fetched = Date.parse(snapshot.fetchedAt);
  if (new Set(snapshot.articles.map((item) => item.id)).size !== snapshot.articles.length ||
    snapshot.bias !== headlineBalance(snapshot.articles).bias ||
    snapshot.articles.some((article) => !article.relevant && article.tone !== "NEUTRAL" ||
      Date.parse(article.publishedAt) > fetched + 5000 ||
      fetched - Date.parse(article.publishedAt) > newsLookbackHours * 3_600_000)) {
    context.addIssue({ code: "custom", message: "News evidence, classification or publication dates are inconsistent." });
  }
});
export type NewsSentiment = z.infer<typeof newsSentimentSchema>;
export type NewsArticle = z.infer<typeof newsArticleSchema>;

export function combineHeadlineClassifications(articles: NewsArticle[], output: unknown) {
  const { headlines } = newsClassificationSchema.parse(output);
  if (headlines.length !== articles.length || new Set(headlines.map((item) => item.id)).size !== articles.length ||
    headlines.some((item) => !articles.some((article) => article.id === item.id))) {
    throw new Error("News classification did not match the retrieved headlines.");
  }
  return articles.map((article) => ({ ...article, ...headlines.find((item) => item.id === article.id)! }));
}

export function assessNewsSentiment(snapshot: NewsSentiment | null, symbol: string | undefined, exchange: string | undefined, now: number) {
  const missing = (reason: string) => ({ available: false as const, reason });
  if (!snapshot) return missing("Company news sentiment has not been loaded.");
  if (snapshot.symbol !== symbol || snapshot.exchange !== exchange) return missing("News belongs to another stock or exchange.");
  const age = now - Date.parse(snapshot.fetchedAt);
  if (!Number.isFinite(age) || age < -5000 || age > newsReceiptMaxAge) return missing("News snapshot is older than 15 minutes; refresh sentiment.");
  const counts = headlineBalance(snapshot.articles);
  if (counts.relevant < 2) return missing("Fewer than two company-relevant headlines; sentiment is unavailable, not neutral.");
  const newest = Math.max(...snapshot.articles.filter((item) => item.relevant).map((item) => Date.parse(item.publishedAt)));
  if (newest > now + 5000 || now - newest > newsHeadlineMaxAge) {
    return missing("No company-relevant headline within six hours. Delayed or old news is context only, not intraday confirmation.");
  }
  return { available: true as const, ...counts };
}
