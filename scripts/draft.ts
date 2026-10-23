import { existsSync, writeFileSync } from "node:fs";
import { stringify } from "yaml";
import { toDate } from "./date.js";

export type DraftSide = "light" | "dark";

export type DraftOptions = {
  url: string;
  side?: DraftSide;
  date?: string;
  title?: string;
};

export type ManualDraft = {
  url: string;
  side: DraftSide;
  date?: string;
  title: string;
  summary: string;
  vendor?: string;
  model?: string;
  severity?: number;
  response?: string;
};

export type DraftResult = {
  path: string;
  id: string;
  title: string;
  date: string;
  side: DraftSide;
  archive?: string;
  manual?: boolean;
};

export function createManualDraft(input: ManualDraft): DraftResult {
  const target = needUrl(input.url);
  const date = toDate(input.date ?? "") ?? new Date().toISOString().slice(0, 10);
  const title = input.title.trim();
  const summary = input.summary.trim();
  if (!title || !summary) throw new Error("手写资料需要标题和摘要。");
  return writeDraft({
    url: target.href,
    side: input.side,
    date,
    title,
    summary,
    vendor: input.vendor?.trim() || "待补充",
    model: input.model?.trim() || "待补充",
    severity: input.side === "dark" ? input.severity : undefined,
    response: input.response?.trim(),
    archive: undefined,
    manual: true,
  });
}

export async function createDraft({ url, side = "dark", date: hintDate, title: hintTitle }: DraftOptions): Promise<DraftResult> {
  const target = needUrl(url);

  const page = await fetch(target, {
    headers: { "user-agent": "liangyi-draft/0.1" },
    signal: AbortSignal.timeout(20000),
    redirect: "follow",
  });
  if (!page.ok) throw new Error(`页面返回 ${page.status}，没有生成草稿。`);

  const html = await page.text();
  const title =
    hintTitle ||
    decode(meta(html, "og:title") ?? meta(html, "twitter:title") ?? tag(html, "title") ?? target.hostname);
  const published = meta(html, "article:published_time") ?? meta(html, "pubdate") ?? "";
  const date = toDate(published) ?? toDate(hintDate ?? "") ?? new Date().toISOString().slice(0, 10);
  const archive = await saveArchive(target.href);
  return writeDraft({
    url: target.href,
    side,
    date,
    title,
    summary: published
      ? "待补充。脚本只抓到来源标题和发布日期，需要人工改写，并决定这是明史还是暗史。"
      : "待补充。脚本没有从来源里读到日期，当前日期是抓取当天，需要人工改正，并决定这是明史还是暗史。",
    vendor: "待补充",
    model: "待补充",
    archive,
  });
}

function needUrl(url: string): URL {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error("这不是一个有效链接。");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("只接受 http 或 https 链接。");
  }
  return target;
}

function writeDraft(input: {
  url: string;
  side: DraftSide;
  date: string;
  title: string;
  summary: string;
  vendor: string;
  model: string;
  severity?: number;
  response?: string;
  archive?: string;
  manual?: boolean;
}): DraftResult {
  const host = new URL(input.url).hostname.replace(/^www\./, "");
  const id = uniqueSlug(host, input.date);
  const path = `src/data/events/${id}.yaml`;
  const draft = {
    date: input.date,
    side: input.side,
    vendor: input.vendor,
    model: input.model,
    title: input.title,
    summary: input.summary,
    category: [] as string[],
    ...(input.severity ? { severity: input.severity } : {}),
    ...(input.response ? { response: input.response } : {}),
    sources: [{ url: input.url, ...(input.archive ? { archive: input.archive } : {}) }],
    verified: false,
    memes: [] as [],
  };
  writeFileSync(path, stringify(draft, { lineWidth: 0 }));
  return { path, id, title: input.title, date: input.date, side: input.side, archive: input.archive, manual: input.manual };
}

const invoked = process.argv[1]?.includes("draft.ts");
if (invoked) {
  const input = process.argv[2];
  if (!input) {
    console.error("用法: pnpm draft <url>");
    process.exit(1);
  }
  try {
    const result = await createDraft({ url: input });
    console.log(result.path);
    if (!result.archive) console.warn("archive.org 这次没有返回存档地址，草稿里只保留了原链接。");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

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
