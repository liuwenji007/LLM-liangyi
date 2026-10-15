import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { parse, parseDocument, stringify } from "yaml";

if (existsSync(".env")) process.loadEnvFile(".env");

const EVENTS_DIR = "src/data/events";
const USER_AGENT = "Mozilla/5.0 (compatible; liangyi-review/0.1; +https://llmliangyi.com)";
const SOURCE_LIMIT = 12000;

type Source = { url: string; archive?: string };
type EventData = {
  date: string | Date;
  side: "light" | "dark";
  vendor: string;
  model: string;
  title: string;
  summary: string;
  category?: string[];
  severity?: number;
  related?: string;
  response?: string;
  sources: Source[];
  verified?: boolean;
};
type Verdict = "pass" | "warn" | "fail";
type Check = { ok: boolean | null; note: string };
type Suggestion = Partial<Pick<EventData, "title" | "summary" | "category" | "severity" | "response">> & {
  date?: string;
};
type Review = {
  verdict: Verdict;
  sources: { url: string; relevant: boolean | null; note: string }[];
  date: Check & { found: string | null };
  summary: Check & { unsupported: string[] };
  severity: Check & { suggested: number | null };
  rules: Check;
  related: Check;
  suggestion: Suggestion | null;
};
type Fetched = { url: string; ok: true; title: string; published: string; text: string } | { url: string; ok: false; error: string };
type Result = { id: string; event: EventData; fetched: Fetched[]; review?: Review; error?: string };

const args = process.argv.slice(2);
const VALUE_OPTIONS = ["--out", "--concurrency", "--changed"];
const outDir = option("--out") ?? "reports/review";
const apiKey = process.env.DEEPSEEK_API_KEY;
const baseUrl = (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/$/, "");
const model = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
const all = loadEvents();

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positional(): string[] {
  return args.filter((arg, index) => !arg.startsWith("--") && !VALUE_OPTIONS.includes(args[index - 1]));
}

function loadEvents(): Map<string, EventData> {
  const events = new Map<string, EventData>();
  for (const file of readdirSync(EVENTS_DIR).filter((name) => name.endsWith(".yaml")).sort()) {
    events.set(file.replace(/\.yaml$/, ""), parse(readFileSync(`${EVENTS_DIR}/${file}`, "utf8")) as EventData);
  }
  return events;
}

function selectIds(): string[] {
  const changed = option("--changed");
  if (changed) {
    const output = execFileSync("git", ["diff", "--name-only", "--diff-filter=AM", `${changed}...HEAD`, "--", EVENTS_DIR], {
      encoding: "utf8",
    });
    return output
      .split("\n")
      .filter((path) => path.endsWith(".yaml"))
      .map((path) => path.split("/").pop()!.replace(/\.yaml$/, ""))
      .filter((id) => all.has(id));
  }
  const named = positional();
  for (const id of named) {
    if (!all.has(id)) {
      console.error(`找不到事件 ${id}`);
      process.exit(1);
    }
  }
  return named.length > 0 ? named : [...all.keys()];
}

async function fetchSource(source: Source): Promise<Fetched> {
  const first = await fetchPage(source.url);
  if (first.ok) return first;
  if (source.archive) {
    const archived = await fetchPage(source.archive);
    if (archived.ok) return { ...archived, url: source.url };
  }
  if (process.env.REVIEW_READER !== "off") {
    const read = await fetchReader(source.url);
    if (read.ok) return read;
  }
  return first;
}

async function fetchReader(url: string): Promise<Fetched> {
  try {
    const response = await fetch(`https://r.jina.ai/${url}`, {
      headers: { accept: "text/plain", "x-return-format": "text" },
      signal: AbortSignal.timeout(45000),
    });
    if (!response.ok) return { url, ok: false, error: `阅读服务返回 ${response.status}` };
    const text = (await response.text()).replace(/\s+/g, " ").trim();
    if (text.length < 200) return { url, ok: false, error: "阅读服务没有拿到正文" };
    const title = /Title:\s*(.+?)\s+URL Source:/.exec(text)?.[1] ?? "";
    const published = /Published Time:\s*(\S+)/.exec(text)?.[1] ?? "";
    return { url, ok: true, title, published, text: text.slice(0, SOURCE_LIMIT) };
  } catch (error) {
    return { url, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function fetchPage(url: string): Promise<Fetched> {
  try {
    const response = await fetch(url, {
      headers: { "user-agent": USER_AGENT, "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" },
      signal: AbortSignal.timeout(20000),
      redirect: "follow",
    });
    if (!response.ok) return { url, ok: false, error: `HTTP ${response.status}` };
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("html") && !type.includes("text")) return { url, ok: false, error: `不支持的类型 ${type}` };
    const html = await response.text();
    const text = pageText(html);
    if (text.length < 200) return { url, ok: false, error: "正文太短，可能需要登录或被拦截" };
    return {
      url,
      ok: true,
      title: decode(meta(html, "og:title") ?? /<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1] ?? ""),
      published: meta(html, "article:published_time") ?? meta(html, "date") ?? meta(html, "citation_date") ?? "",
      text: text.slice(0, SOURCE_LIMIT),
    };
  } catch (error) {
    return { url, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function pageText(html: string): string {
  const cleaned = html.replace(/<(script|style|noscript|svg|nav|footer|header|form)\b[\s\S]*?<\/\1>/gi, " ");
  const body = /<article\b[\s\S]*?<\/article>/i.exec(cleaned)?.[0] ?? /<main\b[\s\S]*?<\/main>/i.exec(cleaned)?.[0] ?? cleaned;
  return decode(body.replace(/<[^>]+>/g, " "));
}

function meta(html: string, key: string): string | undefined {
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
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

function isoDate(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

const SYSTEM_PROMPT = `你是「两仪」的事实核查员。两仪是中文的大模型编年史：明史（light）记发布和里程碑，暗史（dark）记翻车和事后处理。你的任务是对照来源原文核查一条事件，输出 JSON。

收录规则：
- 用户误用模型造成的事，category 必须含「误用」，严重程度最多 3。
- 厂商主动披露的测试结果（系统卡、红队实验），category 必须含「自披露」，严重程度最多 2。
- 平台方的问题（例如 GitHub 误标某个组织）不收进暗史。
- response 只写厂商、监管方或法院做了什么，不能有编者评论或推测。
- 明史不填 severity 和 related；暗史必须有 severity。

严重程度标尺（只用于暗史）：
1 公开争议，没有明确事故（例：GPT-2 暂不公开完整模型）
2 小范围的错误或尴尬，厂商自披露的测试（例：Claude Opus 4 系统卡的勒索实验）
3 明确的产品事故，或用户误用造成的后果（例：R1 自称 ChatGPT；三星员工泄露代码）
4 大范围事故，伴随回滚、下线或股价、商誉上的明显损失（例：Bard 发布广告答错；Gemini 生图暂停）
5 隐私暴露、人身相关伤害，或被监管紧急限制（例：ChatGPT 3 月 20 日故障；意大利限制 ChatGPT）

核查要求：
- 只依据给出的来源原文判断，不要用你自己的记忆补事实。来源没抓到时，对应项填 null 并说明「无法核对」。
- date 是事件发生的日期，不是报道日期。来源里能找到事件日期时填到 found。
- 逐句检查 summary 和 response，把来源里找不到依据的句子原样放进 unsupported。
- related 指向的发布是否就是这次翻车所在的那次发布。
- verdict：来源与事件无关、日期错误、摘要有与来源矛盾的内容时为 fail；有无法核对的部分、轻微不准确或严重程度需要调整时为 warn；全部有依据时为 pass。
- suggestion：只在需要修改时给出，只包含要改的字段，内容必须有来源依据。中文，简洁，陈述事实，不用形容词渲染。不需要修改时为 null。
- note 用中文，一两句话，引用来源原文的关键词。

严格按下面的 JSON 结构输出，不要输出其他内容：
{
  "verdict": "pass" | "warn" | "fail",
  "sources": [{ "url": string, "relevant": boolean | null, "note": string }],
  "date": { "ok": boolean | null, "found": "YYYY-MM-DD" | null, "note": string },
  "summary": { "ok": boolean | null, "unsupported": string[], "note": string },
  "severity": { "ok": boolean | null, "suggested": number | null, "note": string },
  "rules": { "ok": boolean | null, "note": string },
  "related": { "ok": boolean | null, "note": string },
  "suggestion": null | { "date"?: "YYYY-MM-DD", "title"?: string, "summary"?: string, "category"?: string[], "severity"?: number, "response"?: string }
}`;

async function ask(id: string, event: EventData, fetched: Fetched[]): Promise<Review> {
  const parent = event.related ? all.get(event.related) : undefined;
  const sourceBlocks = fetched.map((source, index) =>
    source.ok
      ? `[来源 ${index + 1}] ${source.url}\n标题：${source.title}\n页面标注的发布时间：${source.published || "无"}\n正文：${source.text}`
      : `[来源 ${index + 1}] ${source.url}\n抓取失败：${source.error}`,
  );
  const content = [
    `事件编号：${id}`,
    `事件 YAML：\n${stringify({ ...event, date: isoDate(event.date), memes: undefined }, { lineWidth: 0 })}`,
    parent
      ? `related 指向的明史：${event.related}（${isoDate(parent.date)}，${parent.vendor} ${parent.model}：${parent.title}）`
      : event.related
        ? `related 指向的 ${event.related} 不存在`
        : "没有 related",
    ...sourceBlocks,
  ].join("\n\n");

  const body = JSON.stringify({
    model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content },
    ],
  });

  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(180000),
    });
    if (response.ok) {
      const data = (await response.json()) as { choices: { message: { content: string } }[] };
      return JSON.parse(data.choices[0].message.content) as Review;
    }
    if (attempt >= 2 || (response.status !== 429 && response.status < 500)) {
      throw new Error(`接口返回 ${response.status}：${(await response.text()).slice(0, 200)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)));
  }
}

function finalize(event: EventData, fetched: Fetched[], review: Review): Review {
  if (fetched.every((source) => !source.ok) && review.verdict === "pass") review.verdict = "warn";
  review.suggestion = cleanSuggestion(event, review.suggestion);
  return review;
}

function cleanSuggestion(event: EventData, suggestion: Suggestion | null): Suggestion | null {
  if (!suggestion || typeof suggestion !== "object") return null;
  const clean: Suggestion = {};
  if (typeof suggestion.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(suggestion.date) && suggestion.date !== isoDate(event.date)) {
    clean.date = suggestion.date;
  }
  for (const key of ["title", "summary", "response"] as const) {
    const value = suggestion[key];
    if (typeof value === "string" && value.trim() && value.trim() !== event[key]) clean[key] = value.trim();
  }
  if (Array.isArray(suggestion.category) && suggestion.category.every((item) => typeof item === "string")) {
    if (suggestion.category.join() !== (event.category ?? []).join()) clean.category = suggestion.category;
  }
  const category = clean.category ?? event.category ?? [];
  const severity = suggestion.severity;
  if (event.side === "dark" && Number.isInteger(severity) && severity! >= 1 && severity! <= 5 && severity !== event.severity) {
    const capped = category.includes("自披露") ? 2 : category.includes("误用") ? 3 : 5;
    if (severity! <= capped) clean.severity = severity;
  }
  if (event.side === "light") delete clean.response;
  return Object.keys(clean).length > 0 ? clean : null;
}

async function pool<T, R>(items: T[], size: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const output: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        output[index] = await worker(items[index]);
      }
    }),
  );
  return output;
}

function label(verdict: Verdict | "error"): string {
  return { pass: "通过", warn: "存疑", fail: "不通过", error: "出错" }[verdict];
}

function line(name: string, check: Check | undefined, extra = ""): string {
  if (!check) return `- ${name}：无结果`;
  const mark = check.ok === true ? "没问题" : check.ok === false ? "有问题" : "无法核对";
  return `- ${name}：${mark}。${check.note}${extra}`;
}

function writeReport(results: Result[]) {
  mkdirSync(`${outDir}/suggestions`, { recursive: true });
  const order: Record<string, number> = { error: 0, fail: 1, warn: 2, pass: 3 };
  const sorted = [...results].sort((a, b) => order[a.review?.verdict ?? "error"] - order[b.review?.verdict ?? "error"]);
  const count = (verdict: string) => results.filter((result) => (result.review?.verdict ?? "error") === verdict).length;

  const lines = [
    "# 两仪 AI 审查",
    "",
    `模型 \`${model}\` · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · 共 ${results.length} 条：通过 ${count("pass")} · 存疑 ${count("warn")} · 不通过 ${count("fail")} · 出错 ${count("error")}`,
    "",
    "> AI 结论只作参考，`verified` 仍由维护者决定。建议修改要确认后才会写进 YAML。",
    "",
  ];

  const flagged = sorted.filter((result) => result.review?.verdict !== "pass");
  if (flagged.length > 0) lines.push("## 需要看的", "");
  for (const result of flagged) {
    const { id, event, fetched, review } = result;
    lines.push(`### ${label(review?.verdict ?? "error")} · \`${id}\` ${event.title}`, "");
    if (!review) {
      lines.push(`- 审查出错：${result.error}`, "");
      continue;
    }
    for (const [index, source] of fetched.entries()) {
      const judged = review.sources?.[index];
      const state = !source.ok ? `抓取失败（${source.error}）` : judged?.relevant === false ? "与事件无关" : "已读取";
      lines.push(`- 来源 ${index + 1}：${source.url} ${state}。${judged?.note ?? ""}`);
    }
    lines.push(line("日期", review.date, review.date?.found && review.date.found !== isoDate(event.date) ? `（来源：${review.date.found}，现在：${isoDate(event.date)}）` : ""));
    lines.push(line("摘要", review.summary));
    for (const sentence of review.summary?.unsupported ?? []) lines.push(`  - 没有依据：「${sentence}」`);
    if (event.side === "dark") {
      lines.push(line("严重程度", review.severity, review.severity?.suggested && review.severity.suggested !== event.severity ? `（建议 ${review.severity.suggested}，现在 ${event.severity}）` : ""));
      lines.push(line("关联", review.related));
    }
    lines.push(line("规则", review.rules));
    if (review.suggestion) {
      lines.push("", "建议修改：", "");
      for (const [key, value] of Object.entries(review.suggestion)) {
        const before = key === "date" ? isoDate(event.date) : (event as Record<string, unknown>)[key];
        lines.push(`- \`${key}\`：${format(before)} → ${format(value)}`);
      }
      lines.push("", `确认后执行 \`pnpm review:apply ${id}\``);
      writeFileSync(`${outDir}/suggestions/${id}.json`, `${JSON.stringify(review.suggestion, null, 2)}\n`);
    }
    lines.push("");
  }

  const passed = sorted.filter((result) => result.review?.verdict === "pass");
  if (passed.length > 0) {
    lines.push("## 通过", "");
    for (const result of passed) lines.push(`- \`${result.id}\` ${result.event.title}`);
    lines.push("");
  }

  writeFileSync(`${outDir}/report.md`, lines.join("\n"));
  writeFileSync(`${outDir}/report.json`, `${JSON.stringify(results.map(({ id, fetched, review, error }) => ({ id, review, error, sources: fetched.map((source) => ({ url: source.url, ok: source.ok, error: source.ok ? undefined : source.error })) })), null, 2)}\n`);
  console.log(`报告：${outDir}/report.md`);
}

function format(value: unknown): string {
  if (value === undefined) return "（无）";
  return Array.isArray(value) ? `[${value.join("、")}]` : `「${String(value)}」`;
}

function applySuggestions(targets: string[]) {
  const dir = `${outDir}/suggestions`;
  const everything = args.includes("--all") && existsSync(dir) ? readdirSync(dir).map((file) => file.replace(/\.json$/, "")) : [];
  const ids = targets.length > 0 ? targets : everything;
  if (ids.length === 0) {
    console.error("没有可应用的建议。用法：pnpm review:apply <事件编号...>，或 pnpm review:apply --all");
    process.exit(1);
  }
  for (const id of ids) {
    const suggestionPath = `${dir}/${id}.json`;
    const eventPath = `${EVENTS_DIR}/${id}.yaml`;
    if (!existsSync(suggestionPath) || !existsSync(eventPath)) {
      console.error(`跳过 ${id}：找不到建议或事件文件`);
      continue;
    }
    const suggestion = JSON.parse(readFileSync(suggestionPath, "utf8")) as Suggestion;
    const document = parseDocument(readFileSync(eventPath, "utf8"));
    for (const [key, value] of Object.entries(suggestion)) document.set(key, value);
    writeFileSync(eventPath, document.toString({ lineWidth: 0 }));
    console.log(`已应用 ${id}：${Object.keys(suggestion).join("、")}`);
  }
  console.log("改完运行 pnpm build 检查一遍。");
}

async function main() {
  if (args.includes("--apply")) {
    applySuggestions(positional());
    return;
  }
  if (!apiKey) {
    console.error("缺少 DEEPSEEK_API_KEY。复制 .env.example 为 .env 并填上 key。");
    process.exit(1);
  }

  const ids = selectIds();
  if (ids.length === 0) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(`${outDir}/report.md`, "# 两仪 AI 审查\n\n这次改动没有涉及事件文件。\n");
    console.log("没有需要审查的事件。");
    return;
  }

  console.log(`审查 ${ids.length} 条，模型 ${model}`);
  const results = await pool(ids, Number(option("--concurrency") ?? 3), async (id): Promise<Result> => {
    const event = all.get(id)!;
    const fetched = await Promise.all(event.sources.map(fetchSource));
    try {
      const review = finalize(event, fetched, await ask(id, event, fetched));
      console.log(`${label(review.verdict)}  ${id}`);
      return { id, event, fetched, review };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`出错  ${id}：${message}`);
      return { id, event, fetched, error: message };
    }
  });
  writeReport(results);
}

await main();
