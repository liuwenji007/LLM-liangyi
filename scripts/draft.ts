import { existsSync, writeFileSync } from "node:fs";
import { stringify } from "yaml";

const input = process.argv[2];

if (!input) {
  console.error("用法: pnpm draft <url>");
  process.exit(1);
}

let target: URL;
try {
  target = new URL(input);
} catch {
  console.error("这不是一个有效链接。");
  process.exit(1);
}

if (target.protocol !== "http:" && target.protocol !== "https:") {
  console.error("只接受 http 或 https 链接。");
  process.exit(1);
}

const page = await fetch(target, {
  headers: { "user-agent": "liangyi-draft/0.1" },
  signal: AbortSignal.timeout(20000),
  redirect: "follow",
});

if (!page.ok) {
  console.error(`页面返回 ${page.status}，没有生成草稿。`);
  process.exit(1);
}

const html = await page.text();
const title = decode(meta(html, "og:title") ?? meta(html, "twitter:title") ?? tag(html, "title") ?? target.hostname);
const published = meta(html, "article:published_time") ?? meta(html, "pubdate") ?? "";
const date = toDate(published) ?? new Date().toISOString().slice(0, 10);
const archive = await saveArchive(target.href);

const slug = uniqueSlug(target.hostname.replace(/^www\./, ""), date);
const draft = {
  date,
  side: "dark",
  vendor: "待补充",
  model: "待补充",
  title,
  summary: published
    ? "待补充。脚本只抓到来源标题和发布日期，需要人工改写，并决定这是明史还是暗史。"
    : "待补充。脚本没有从来源里读到日期，当前日期是抓取当天，需要人工改正，并决定这是明史还是暗史。",
  category: [] as string[],
  sources: [{ url: target.href, ...(archive ? { archive } : {}) }],
  verified: false,
  memes: [] as [],
};

const path = `src/data/events/${slug}.yaml`;
writeFileSync(path, stringify(draft, { lineWidth: 0 }));
console.log(path);
if (!archive) console.warn("archive.org 这次没有返回存档地址，草稿里只保留了原链接。");

function meta(html: string, key: string): string | undefined {
  const pattern = new RegExp(
    `<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${key}["']`,
    "i",
  );
  const match = pattern.exec(html);
  return match?.[1] ?? match?.[2];
}

function tag(html: string, name: string): string | undefined {
  return new RegExp(`<${name}[^>]*>([^<]+)</${name}>`, "i").exec(html)?.[1];
}

function decode(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function toDate(value: string): string | undefined {
  const match = /(\d{4}-\d{2}-\d{2})/.exec(value);
  return match?.[1];
}

async function saveArchive(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(`https://web.archive.org/save/${url}`, {
      redirect: "manual",
      headers: { "user-agent": "liangyi-draft/0.1" },
      signal: AbortSignal.timeout(25000),
    });
    const location = response.headers.get("content-location") ?? response.headers.get("location");
    if (location) return location.startsWith("http") ? location : new URL(location, "https://web.archive.org").href;
    const body = await response.text();
    return body.match(/https:\/\/web\.archive\.org\/web\/\d+\/\S+/)?.[0];
  } catch (error) {
    console.warn("存档请求失败。", error instanceof Error ? error.message : error);
    return undefined;
  }
}

function uniqueSlug(host: string, date: string): string {
  const base = `${host}-${date}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!existsSync(`src/data/events/${base}.yaml`)) return base;
  for (let index = 2; index < 100; index += 1) {
    const next = `${base}-${index}`;
    if (!existsSync(`src/data/events/${next}.yaml`)) return next;
  }
  return `${base}-${Date.now()}`;
}
