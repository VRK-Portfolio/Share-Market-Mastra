import { z } from "zod";
import { newsArticleSchema, newsLookbackHours } from "./news-sentiment.ts";
import type { NewsArticle } from "./news-sentiment.ts";

const providerResponse = z.object({ articles: z.array(z.unknown()).max(100) });
const providerArticle = z.object({
  title: newsArticleSchema.shape.title, url: newsArticleSchema.shape.url,
  publishedAt: newsArticleSchema.shape.publishedAt,
  source: z.object({ name: newsArticleSchema.shape.source }),
});
export class CompanyNewsError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) { super(message); this.status = status; }
}
export function selectCompanyHeadlines(body: unknown, now: number): NewsArticle[] {
  const raw = providerResponse.parse(body);
  const seen = new Set<string>();
  return raw.articles.flatMap((item) => {
    const parsed = providerArticle.safeParse(item);
    if (!parsed.success) return [];
    const article = parsed.data;
    const age = now - Date.parse(article.publishedAt);
    if (age < -5000 || age > newsLookbackHours * 3_600_000) return [];
    return [{ ...article, source: article.source.name }];
  }).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).filter((article) => {
    const title = article.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const url = new URL(article.url);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^utm_|^(?:fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    const link = url.toString();
    if (seen.has(title) || seen.has(link)) return false;
    seen.add(title); seen.add(link);
    return true;
  }).slice(0, 8).map((article, index) => ({ ...article, id: `h${index + 1}` }));
}
export async function fetchCompanyNews(
  symbol: string, companyName: string, apiKey: string, signal: AbortSignal,
) {
  const name = companyName.replace(/\b(?:limited|ltd)\b\.?/gi, "").replace(/["\\]/g, "").trim();
  const words = name.split(/\s+/);
  const shortName = words.slice(0, words[1] === "&" ? 3 : 2).join(" ");
  const query = [...new Set([symbol, name, shortName])].filter(Boolean).map((value) => `"${value}"`).join(" OR ");
  const now = Date.now();
  const url = new URL("https://gnews.io/api/v4/search");
  url.search = new URLSearchParams({
    q: query.length <= 200 ? query : `"${symbol}"`, lang: "en", country: "in", in: "title",
    max: "10", sortby: "publishedAt", from: new Date(now - newsLookbackHours * 3_600_000).toISOString(),
    nullable: "description,content,image", truncate: "content", apikey: apiKey,
  }).toString();
  const response = await fetch(url, { cache: "no-store", signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new CompanyNewsError(response.status === 401 || response.status === 403
    ? "GNews denied access. Check the server API key, plan and permitted use."
    : response.status === 429 ? "GNews quota or rate limit reached. Wait before refreshing sentiment."
      : "The news provider is unavailable. Retry sentiment later.", response.status === 429 ? 429 : 502);
  if (!response.body) throw new CompanyNewsError("The news provider returned an empty response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 512_000) throw new CompanyNewsError("The news response exceeded the size limit.");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel(); reader.releaseLock(); }
  const fetchedAt = new Date(Date.now()).toISOString();
  const body: unknown = JSON.parse(text);
  const articles = selectCompanyHeadlines(body, Date.parse(fetchedAt));
  if (providerResponse.parse(body).articles.length && !articles.length) {
    throw new CompanyNewsError("The provider returned no usable dated headlines in the last 72 hours.");
  }
  return { articles, fetchedAt };
}
