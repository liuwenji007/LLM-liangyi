import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";

type PoolSource = { id: string; name?: string; url: string; feed?: string; status?: string };
type FeedItem = { title: string; url: string; date: string; summary: string };
type FeedCache = Record<string, { at: number; items: FeedItem[] }>;

export type Fetched = {
  url: string;
  /** direct = 抓到正文；feed = 只有 RSS 导语；none = 两者都没有 */
  via: "direct" | "feed" | "none";
  title: string;
  published: string;
  text: string;
  note?: string;
};

const SOURCES = "src/data/sources.yaml";
const CACHE = "reports/precheck/.feeds.json";
const FEED_TTL = 6 * 60 * 60 * 1000;
const TEXT_LIMIT = 12000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export function loadPool(path = SOURCES): PoolSource[] {
  if (!existsSync(path)) return [];
  const data = (parse(readFileSync(path, "utf8")) ?? {}) as { sources?: PoolSource[] };
  return (data.sources ?? []).filter((source) => source.url);
}

export function norm(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.startsWith("utm_")) parsed.searchParams.delete(key);
    }
    return parsed.href.replace(/\/$/, "").toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

export function host(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * 取一条候选的原文。
 * 顺序：直接抓正文 → 同站 RSS 导语 → 放弃。
 * RSS 这一步是为了绕开 openai.com 这类对 curl / node fetch 返回 403 的站点：
 * 它的 RSS 不需要过 Cloudflare，导语足够做入库前的粗判，全文核实仍留给 `pnpm review`。
 */
export async function fetchSource(url: string, pool: PoolSource[]): Promise<Fetched> {
  const direct = await directText(url);
  if (direct) return { url, via: "direct", text: direct.text, title: direct.title, published: direct.published };

  const feed = await feedText(url, pool);
  if (feed) {
    return {
      url,
      via: "feed",
      text: feed.summary,
      title: feed.title,
      published: feed.date,
      note: "只有 RSS 导语，全文核实留给 pnpm review",
    };
  }
  return { url, via: "none", text: "", title: "", published: "", note: "正文与导语都没取到" };
}

async function directText(url: string): Promise<{ text: string; title: string; published: string } | null> {
  try {
    const response = await fetch(url, {
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml", "accept-language": "en,zh-CN;q=0.9" },
      signal: AbortSignal.timeout(20000),
      redirect: "follow",
    });
    if (!response.ok) return null;
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("html") && !type.includes("text")) return null;
    const html = await response.text();
    if (/Enable JavaScript and cookies to continue/i.test(html.slice(0, 4000))) return null;
    const body = /<article\b[\s\S]*?<\/article>/i.exec(html)?.[0] ?? /<main\b[\s\S]*?<\/main>/i.exec(html)?.[0] ?? html;
    const text = strip(body);
    if (text.length < 400) return null;
    return {
      text: text.slice(0, TEXT_LIMIT),
      title: text2attr(html, "og:title") ?? /<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1] ?? "",
      published: text2attr(html, "article:published_time") ?? text2attr(html, "date") ?? "",
    };
  } catch {
    return null;
  }
}

async function feedText(url: string, pool: PoolSource[]): Promise<FeedItem | null> {
  const site = host(url);
  if (!site) return null;
  const feeds = pool.filter((source) => source.feed && host(source.url) === site).map((source) => source.feed!);
  for (const feed of feeds) {
    const items = await loadFeed(feed);
    const match = items.find((item) => norm(item.url) === norm(url));
    if (match) return match;
  }
  return null;
}

async function loadFeed(feedUrl: string): Promise<FeedItem[]> {
  const cache = readCache();
  const hit = cache[feedUrl];
  if (hit && Date.now() - hit.at < FEED_TTL) return hit.items;
  try {
    const response = await fetch(feedUrl, {
      headers: { "user-agent": UA, accept: "application/rss+xml,application/xml,text/xml" },
      signal: AbortSignal.timeout(35000),
      redirect: "follow",
    });
    if (!response.ok) return hit?.items ?? [];
    const items = parseFeed(await response.text());
    if (items.length === 0) return hit?.items ?? [];
    cache[feedUrl] = { at: Date.now(), items };
    writeCache(cache);
    return items;
  } catch {
    return hit?.items ?? [];
  }
}

function readCache(): FeedCache {
  if (!existsSync(CACHE)) return {};
  try {
    return JSON.parse(readFileSync(CACHE, "utf8")) as FeedCache;
  } catch {
    return {};
  }
}

function writeCache(cache: FeedCache) {
  mkdirSync("reports/precheck", { recursive: true });
  writeFileSync(CACHE, JSON.stringify(cache));
}

function parseFeed(xml: string): FeedItem[] {
  return xml
    .split(/<item\b|<entry\b/i)
    .slice(1)
    .map((chunk) => {
      const title = tag(chunk, "title");
      const href = /<link[^>]+href=["']([^"']+)["']/i.exec(chunk)?.[1];
      const bare = tag(chunk, "link");
      const link = href || (bare.startsWith("http") ? bare : "");
      const date = tag(chunk, "pubDate") || tag(chunk, "updated") || tag(chunk, "published");
      const summary = (tag(chunk, "description") || tag(chunk, "summary") || tag(chunk, "content")).slice(0, 2000);
      return { title, url: link, date, summary };
    })
    .filter((item) => item.url.startsWith("http") && item.title);
}

function tag(chunk: string, name: string): string {
  const raw = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(chunk)?.[1] ?? "";
  return decode(raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).replace(/<[^>]+>/g, "").trim();
}

function strip(html: string): string {
  const cleaned = html.replace(/<(script|style|noscript|svg|nav|footer|header|form)\b[\s\S]*?<\/\1>/gi, " ");
  return decode(cleaned.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function text2attr(html: string, key: string): string | undefined {
  const pattern = new RegExp(
    `<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${key}["']`,
    "i",
  );
  const match = pattern.exec(html);
  return match?.[1] ?? match?.[2];
}

function decode(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}
