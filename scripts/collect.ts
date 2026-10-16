import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { parse } from "yaml";

const SOURCES = "src/data/sources.yaml";
const EVENTS = "src/data/events";
const OUT = "reports/collect";
const UA = "liangyi-collect/0.1 (+https://llmliangyi.com)";

type PoolSource = {
  id: string;
  name: string;
  url: string;
  tier: number;
  status: string;
  feed?: string;
  collect?: string;
  lane?: string;
  kind?: string;
};

type Hit = {
  title: string;
  url: string;
  date: string;
  via: string;
  tier: number;
  lane: string;
  summary?: string;
};

const args = process.argv.slice(2);
const windowArg = option("--window") ?? "7d";
const draftN = Number(option("--draft") ?? "0");
const windowMs = windowArg === "24h" ? 86_400_000 : windowArg === "30d" ? 30 * 86_400_000 : 7 * 86_400_000;
const since = Date.now() - windowMs;

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const pool = (parse(readFileSync(SOURCES, "utf8")) as { sources: PoolSource[] }).sources.filter(
  (source) => source.status === "approved",
);
const known = loadKnown();
const hits: Hit[] = [];
const notes: string[] = [];

for (const source of pool) {
  if (source.collect === "aihot") {
    const found = await collectAihot(source);
    hits.push(...found.items);
    if (found.error) notes.push(`${source.id}：${found.error}`);
    else notes.push(`${source.id}：${found.items.length} 条新线索`);
    continue;
  }
  if (!source.feed || source.kind === "archive") continue;
  try {
    const xml = await getText(source.feed);
    const items = parseFeed(xml)
      .filter((item) => !item.date || Date.parse(item.date) >= since)
      .filter((item) => !known.has(norm(item.url)));
    for (const item of items) {
      hits.push({ ...item, via: source.id, tier: source.tier, lane: source.lane ?? "chronicle" });
    }
    notes.push(`${source.id}：${items.length} 条新线索`);
  } catch (error) {
    notes.push(`${source.id}：抓取失败（${error instanceof Error ? error.message : error}）`);
  }
}

const skipped = pool.filter((source) => source.collect !== "aihot" && !source.feed && source.kind !== "archive");
const fresh = dedupe(hits);

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/candidates.json`, JSON.stringify({ generatedAt: new Date().toISOString(), window: windowArg, notes, skipped: skipped.map((s) => s.id), items: fresh }, null, 2));
writeFileSync(`${OUT}/candidates.md`, render(fresh, notes, skipped.map((s) => s.id)));
console.log(`新线索 ${fresh.length} 条，报告 ${OUT}/candidates.md`);
for (const line of notes) console.log(`  ${line}`);
if (skipped.length) console.log(`  未配 feed、本次跳过：${skipped.map((s) => s.id).join("、")}`);

if (draftN > 0) {
  for (const hit of fresh.slice(0, draftN)) {
    console.log(`起草 ${hit.url}`);
    execFileSync("pnpm", ["exec", "tsx", "scripts/draft.ts", hit.url], { stdio: "inherit" });
  }
}

function loadKnown(): Set<string> {
  const urls = new Set<string>();
  for (const file of readdirSync(EVENTS).filter((name) => name.endsWith(".yaml"))) {
    const data = parse(readFileSync(`${EVENTS}/${file}`, "utf8")) as { sources?: { url?: string }[] };
    for (const source of data.sources ?? []) {
      if (source.url) urls.add(norm(source.url));
    }
  }
  return urls;
}

async function collectAihot(source: PoolSource): Promise<{ items: Hit[]; error?: string }> {
  const window = windowArg === "24h" ? "24h" : "7d";
  const items: Hit[] = [];
  let cursor = "";
  try {
    for (let page = 0; page < 4; page += 1) {
      const url = new URL("https://aihot.news/api/v1/items");
      url.searchParams.set("mode", "selected");
      url.searchParams.set("window", window);
      url.searchParams.set("limit", "50");
      if (cursor) url.searchParams.set("cursor", cursor);
      const data = (await getJson(url.href)) as {
        items?: { title: string; summary?: string; publishedAt?: string; links?: { original?: string } }[];
        page?: { hasMore?: boolean; nextCursor?: string };
      };
      for (const item of data.items ?? []) {
        const link = item.links?.original;
        if (!link || known.has(norm(link))) continue;
        if (item.publishedAt && Date.parse(item.publishedAt) < since) continue;
        items.push({
          title: item.title,
          url: link,
          date: (item.publishedAt ?? "").slice(0, 10),
          via: source.id,
          tier: source.tier,
          lane: source.lane ?? "both",
          summary: item.summary,
        });
      }
      if (!data.page?.hasMore || !data.page.nextCursor) break;
      cursor = data.page.nextCursor;
    }
    return { items };
  } catch (error) {
    return { items, error: error instanceof Error ? error.message : String(error) };
  }
}

function parseFeed(xml: string): { title: string; url: string; date: string }[] {
  return xml
    .split(/<item\b|<entry\b/i)
    .slice(1)
    .map((chunk) => {
      const title = text(chunk, "title");
      const href = /<link[^>]+href=["']([^"']+)["']/i.exec(chunk)?.[1];
      const bare = text(chunk, "link");
      const url = href || (bare.startsWith("http") ? bare : "");
      const date = text(chunk, "pubDate") || text(chunk, "updated") || text(chunk, "published");
      return { title, url, date };
    })
    .filter((item) => item.url.startsWith("http") && item.title);
}

function text(chunk: string, tag: string): string {
  const raw = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(chunk)?.[1] ?? "";
  return decode(raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).replace(/<[^>]+>/g, "").trim();
}

function decode(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function dedupe(items: Hit[]): Hit[] {
  const seen = new Set<string>();
  const out: Hit[] = [];
  for (const item of items) {
    const key = norm(item.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function norm(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.startsWith("utm_")) parsed.searchParams.delete(key);
    }
    return parsed.href.replace(/\/$/, "");
  } catch {
    return url;
  }
}

function render(items: Hit[], log: string[], skippedIds: string[]): string {
  const lines = [
    `# 收集候选`,
    ``,
    `窗口 ${windowArg} · ${new Date().toISOString()} · 新线索 ${items.length} 条`,
    ``,
    `这些是发现结果，不是已核实事件。编年仍要追一手来源，再用 \`pnpm draft\` / \`pnpm review\`。`,
    ``,
    ...log.map((line) => `- ${line}`),
    ``,
  ];
  if (skippedIds.length) {
    lines.push(`未配置 \`feed\`、本次未扫：${skippedIds.join("、")}`, ``);
  }
  if (!items.length) {
    lines.push("没有新链接。");
    return lines.join("\n");
  }
  lines.push("| 日期 | 来自 | 级 | 标题 | 链接 |", "|---|---|---|---|---|");
  for (const item of items) {
    const title = item.title.replace(/\|/g, "/");
    lines.push(`| ${item.date || "—"} | ${item.via} | ${item.tier} | ${title} | ${item.url} |`);
  }
  return `${lines.join("\n")}\n`;
}

async function getText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20000), redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function getJson(url: string): Promise<unknown> {
  return JSON.parse(await getText(url));
}
