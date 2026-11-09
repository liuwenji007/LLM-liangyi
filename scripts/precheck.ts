import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { parse } from "yaml";
import { loadPrefilter, matchPrefilter, type PrefilterHit } from "./lib/prefilter";
import { stringify } from "yaml";
import { fetchSource, host, loadPool, norm, type Fetched } from "./lib/source-text";
import { createManualDraft } from "./draft";

/**
 * 预审台：把开放的候选 Issue 压成一张能在一屏内点完的单子。
 *
 * 入口是 `pnpm queue`，不能叫 precheck：pnpm 会为每个脚本跑 `pre<名字>` 钩子，
 * `pnpm check` 会连带执行它，CI 直接跑挂（这个坑踩过一次）。
 *
 * 只做「收 / 不收 / 待定」这一层判断，不写 YAML、不改 verified。
 * 行得通之后的动作仍然是 /收 → 草稿 PR → pnpm review → /核实。
 */

type Issue = { number: number; title: string; body?: string | null; html_url?: string; labels?: (string | { name?: string })[] };
type Decision = "收" | "不收" | "待定";
type Verdict = {
  decision: Decision;
  side: "light" | "dark" | null;
  vendor: string;
  model: string;
  date: string | null;
  title_zh: string;
  summary_zh: string;
  response: string | null;
  severity: number | null;
  category: string[];
  related: string | null;
  dup_of: string | null;
  why: string;
  confidence: "高" | "中" | "低";
};
type Row = {
  number: number;
  issueUrl: string;
  url: string;
  title: string;
  collectedAt: string;
  suggested: string;
  summary: string;
  rule: PrefilterHit | null;
  fetched: Omit<Fetched, "text"> & { chars: number };
  verdict: Verdict | null;
  error?: string;
  seconds: number;
};

const args = process.argv.slice(2);
const option = (name: string, fallback?: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};

const OUT = option("--out", "reports/precheck")!;
const LIMIT = Number(option("--limit", "200"));
const CONCURRENCY = Number(option("--concurrency", "4"));
const EVENTS_DIR = "src/data/events";

const baseUrl = (process.env.PRECHECK_BASE_URL ?? process.env.DEEPSEEK_BASE_URL ?? "http://127.0.0.1:8000/v1").replace(/\/$/, "");
const isLocal = /127\.0\.0\.1|localhost/.test(baseUrl);
const model = process.env.PRECHECK_MODEL ?? process.env.DEEPSEEK_MODEL ?? (isLocal ? "rapid-mlx/Qwen3.8-27B-4bit-MTP-MLX" : "deepseek-chat");
const apiKey = process.env.PRECHECK_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? (isLocal ? "local" : "");
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
const repo = process.env.GITHUB_REPOSITORY ?? "liuwenji007/LLM-liangyi";

const library = loadLibrary();
const prefilter = loadPrefilter();
const pool = loadPool();

function loadLibrary(): {
  id: string;
  date: string;
  vendor: string;
  title: string;
  side: string;
  sources: string[];
}[] {
  return readdirSync(EVENTS_DIR)
    .filter((name) => name.endsWith(".yaml"))
    .map((name) => {
      const data = (parse(readFileSync(`${EVENTS_DIR}/${name}`, "utf8")) ?? {}) as Record<string, unknown>;
      const sources = Array.isArray(data.sources) ? (data.sources as { url?: string }[]) : [];
      return {
        id: name.replace(/\.yaml$/, ""),
        date: String(data.date instanceof Date ? data.date.toISOString().slice(0, 10) : data.date ?? "").slice(0, 10),
        vendor: String(data.vendor ?? ""),
        title: String(data.title ?? ""),
        side: String(data.side ?? ""),
        sources: sources.map((item) => item.url ?? "").filter(Boolean),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function loadIssues(): Promise<Issue[]> {
  const from = option("--from");
  if (from) {
    const raw = JSON.parse(readFileSync(from, "utf8")) as Issue[];
    return raw.filter((issue) => !/\/pull\//.test(issue.html_url ?? "") && (issue.body ?? "").length > 0);
  }
  if (!token) throw new Error("没有 GITHUB_TOKEN，也没给 --from。用 --from 传一份 issue 列表 JSON。");
  const issues: Issue[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetch(`https://api.github.com/repos/${repo}/issues?state=open&per_page=100&page=${page}`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "liangyi-precheck/0.1" },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`GitHub ${response.status}：${(await response.text()).slice(0, 200)}`);
    const batch = (await response.json()) as Issue[];
    issues.push(...batch.filter((issue) => !(issue as { pull_request?: unknown }).pull_request));
    if (batch.length < 100) break;
  }
  return issues;
}

function field(body: string, name: string): string {
  const match = new RegExp(`^- ${name}：(.*)$`, "m").exec(body);
  return match?.[1]?.trim() ?? "";
}

const SYSTEM = `你是「两仪」的入库预审员。两仪是中文的大模型编年史：明史（light）记发布与里程碑，暗史（dark）记翻车、事故、监管与事后。
中国读者看的是一条有时间、有出处、能翻回去核对的事件线，不是新闻聚合。宁缺勿滥。

已入库条目（编号 | 日期 | 明/暗 | 厂商 | 标题）：
${library.map((event) => `${event.id} | ${event.date} | ${event.side === "dark" ? "暗" : "明"} | ${event.vendor} | ${event.title}`).join("\n")}

收录标准：
- 明史只收改变公众对该模型能力认知的发布：重要版本、能力跃迁、定价结构变化、行业格局级合作。
- 暗史只收有明确后果的翻车：事故、回滚、下线、监管处罚、诉讼、被撤下的功能。用户误用造成的算暗史，严重程度最多 3。
- 不收：客户案例与营销软文、基础设施投资与数据中心选址、招聘与人事、并购与财报、面向教育/公益的资助、纯演示与教程、公司治理与价值观文档、第三方开发者博客的库更新。
- 拿不准就填「待定」，不要为了凑数填「收」。
- 与已入库条目重复的，dup_of 填那个编号，decision 填「不收」。
- summary_zh 只能用给到的材料里能查到的内容，60 字以内，陈述事实，不用形容词。
- 暗史要写 response：只写厂商、监管方或法院做了什么（道歉、回滚、下架、罚款、被起诉），不写推测和评论。原文里没有就填 null。
- 暗史能对上一次明史发布时，related 填那条明史的编号，必须是上面列表里的「明」条目，日期不能早于它。没有把握就填 null。
- 明史不填 severity、related、response。
- 只有 RSS 导语、没有正文时，confidence 填「低」，并且不要在 summary_zh 里写导语没有的事实。

只输出 JSON，不要别的内容：
{"decision":"收|不收|待定","side":"light|dark|null","vendor":"","model":"","date":"YYYY-MM-DD|null","title_zh":"","summary_zh":"","response":null,"severity":null,"category":[],"related":null,"dup_of":null,"why":"一句中文","confidence":"高|中|低"}`;

async function classify(row: { title: string; url: string; collectedAt: string; suggested: string; summary: string }, source: Fetched): Promise<Verdict> {
  const material = source.text
    ? `原文（via ${source.via}${source.via === "feed" ? "，只有导语" : ""}）：\n${source.text.slice(0, 9000)}`
    : `原文：抓取失败。只能看采集摘要，不足以判定，请填「待定」。`;
  const content = [
    `候选标题：${row.title}`,
    `链接：${row.url}`,
    `采集日期：${row.collectedAt || "未知"}`,
    `采集时建议的面：${row.suggested || "待定"}`,
    row.summary ? `采集摘要：${row.summary}` : "",
    material,
  ]
    .filter(Boolean)
    .join("\n\n");

  const body = JSON.stringify({
    model,
    temperature: 0,
    max_tokens: 600,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content },
    ],
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body,
        signal: AbortSignal.timeout(180000),
      });
      if (!response.ok) throw new Error(`接口 ${response.status}：${(await response.text()).slice(0, 160)}`);
      const data = (await response.json()) as { choices: { message: { content: string } }[] };
      const raw = data.choices[0]?.message?.content ?? "";
      return normalize(JSON.parse(/\{[\s\S]*\}/.exec(raw)?.[0] ?? "{}") as Partial<Verdict>, source);
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
  throw new Error("不可达");
}

function normalize(verdict: Partial<Verdict>, source: Fetched): Verdict {
  const decision: Decision = verdict.decision === "收" || verdict.decision === "不收" ? verdict.decision : "待定";
  const side = verdict.side === "light" || verdict.side === "dark" ? verdict.side : null;
  const severity = Number.isInteger(verdict.severity) ? Number(verdict.severity) : null;
  let result: Verdict = {
    decision,
    side,
    vendor: String(verdict.vendor ?? "").trim(),
    model: String(verdict.model ?? "").trim(),
    date: typeof verdict.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(verdict.date) ? verdict.date : null,
    title_zh: String(verdict.title_zh ?? "").trim(),
    summary_zh: String(verdict.summary_zh ?? "").trim(),
    response: typeof verdict.response === "string" && verdict.response.trim() && verdict.response !== "null" ? verdict.response.trim() : null,
    severity,
    category: Array.isArray(verdict.category) ? verdict.category.filter((item): item is string => typeof item === "string") : [],
    related: typeof verdict.related === "string" && verdict.related.trim() ? verdict.related.trim() : null,
    dup_of: typeof verdict.dup_of === "string" && verdict.dup_of.trim() && verdict.dup_of !== "null" ? verdict.dup_of.trim() : null,
    why: String(verdict.why ?? "").trim(),
    confidence: verdict.confidence === "高" || verdict.confidence === "低" ? verdict.confidence : "中",
  };

  // 只拿到导语时，不给出「高」的把握。
  if (source.via !== "direct" && result.confidence === "高") result.confidence = "中";
  // 暗史没有严重程度，进了草稿也会被 astro 的 schema 拦下。
  if (result.decision === "收" && result.side === "dark" && result.severity === null) {
    result = { ...result, decision: "待定", why: `${result.why}（暗史缺严重程度，需人定）`.trim() };
  }
  // 重复条目不该走 /收。
  if (result.dup_of && result.decision === "收") {
    result = { ...result, decision: "不收", why: `已在库：${result.dup_of}。${result.why}`.trim() };
  }
  return result;
}

async function one(issue: Issue): Promise<Row> {
  const body = issue.body ?? "";
  const url = (/^source:\s*(\S+)$/m.exec(body)?.[1] ?? "").trim();
  const title = issue.title.replace(/^候选[：:]\s*/, "");
  const collected = field(body, "日期");
  const collectedAt = /^\d{4}-\d{2}-\d{2}/.test(collected) ? collected.slice(0, 10) : isoOrEmpty(collected);
  const suggested = field(body, "建议面");
  const summary = field(body, "摘要");
  const issueUrl = issue.html_url ?? `https://github.com/${repo}/issues/${issue.number}`;
  const started = Date.now();

  const rule = url ? matchPrefilter(prefilter, { title, url }) : null;
  if (!url) {
    return {
      number: issue.number,
      issueUrl,
      url,
      title,
      collectedAt,
      suggested,
      summary,
      rule,
      fetched: { url, via: "none", title: "", published: "", note: "正文里没有 source 行", chars: 0 },
      verdict: null,
      error: "没有 source 链接",
      seconds: 0,
    };
  }

  // 规则命中就没什么可问模型、也没什么可抓的，省一次请求。
  if (rule?.action === "drop") {
    return {
      number: issue.number,
      issueUrl,
      url,
      title,
      collectedAt,
      suggested,
      summary,
      rule,
      fetched: { url, via: "none", title: "", published: "", note: "规则丢弃，未抓取", chars: 0 },
      verdict: {
        decision: "不收",
        side: null,
        vendor: "",
        model: "",
        date: null,
        title_zh: "",
        summary_zh: "",
        response: null,
        severity: null,
        category: [],
        related: null,
        dup_of: null,
        why: `规则 ${rule.id}：${rule.why}`,
        confidence: "高",
      },
      seconds: 0,
    };
  }

  const source = await fetchSource(url, pool);
  const fetched = { url: source.url, via: source.via, title: source.title, published: source.published, note: source.note, chars: source.text.length };
  const base = { number: issue.number, issueUrl, url, title, collectedAt, suggested, summary, rule, fetched, seconds: 0 };

  try {
    const verdict = await classify({ title, url, collectedAt, suggested, summary }, source);
    return { ...base, verdict, seconds: Math.round((Date.now() - started) / 100) / 10 };
  } catch (error) {
    return { ...base, verdict: null, error: error instanceof Error ? error.message : String(error), seconds: Math.round((Date.now() - started) / 100) / 10 };
  }
}

async function poolMap<T, R>(items: T[], size: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const output: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        output[index] = await worker(items[index]);
        process.stdout.write(".");
      }
    }),
  );
  return output;
}

function isoOrEmpty(value: string): string {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString().slice(0, 10);
}

/** 只重画页面，不重新调用模型：改了样式或排序时用。 */
function renderOnly() {
  const file = `${OUT}/queue.json`;
  if (!existsSync(file)) throw new Error(`找不到 ${file}，先跑一次 pnpm queue。`);
  const saved = JSON.parse(readFileSync(file, "utf8")) as { model: string; rows: Row[] };
  const stats = summarize(saved.rows);
  writeFileSync(file, `${JSON.stringify({ generatedAt: new Date().toISOString(), model: saved.model, stats, rows: saved.rows }, null, 2)}\n`);
  writeFileSync(`${OUT}/report.md`, renderMarkdown(saved.rows, stats));
  writeFileSync(`${OUT}/index.html`, renderHtml(saved.rows, stats));
  console.log(`重画完成：${OUT}/index.html`);
}

/**
 * 把预审结果直接写成草稿并开 PR。
 *
 * 云端 accept 只能抓到标题和日期，厂商、型号、摘要会留成「待补充」，
 * 等于把最贵的一项是让人再写一遍。这里用预审已经算好的字段填满，
 * `verified` 仍然是 false，`/核实` 仍然是唯一能翻它的一步。
 */
async function draftFromQueue(numbers: number[]) {
  const file = `${OUT}/queue.json`;
  if (!existsSync(file)) throw new Error(`找不到 ${file}，先跑一次 pnpm queue。`);
  if (!token) throw new Error("开 PR 需要 GITHUB_TOKEN。");
  if (numbers.length === 0) throw new Error("用法：pnpm queue --draft <issue 号> [...]");

  const saved = JSON.parse(readFileSync(file, "utf8")) as { rows: Row[] };
  for (const number of numbers) {
    const row = saved.rows.find((item) => item.number === number);
    if (!row?.verdict) throw new Error(`队列里没有 #${number} 的预审结果。`);
    const verdict = row.verdict;
    const missing = [
      verdict.decision !== "收" ? `判定是「${verdict.decision}」，不是「收」` : "",
      !verdict.side ? "缺明暗" : "",
      !verdict.vendor ? "缺厂商" : "",
      !verdict.model ? "缺型号" : "",
      !verdict.title_zh ? "缺中文标题" : "",
      !verdict.summary_zh ? "缺中文摘要" : "",
      verdict.side === "dark" && !verdict.severity ? "暗史缺严重程度" : "",
    ].filter(Boolean);
    if (missing.length > 0) throw new Error(`#${number} 不能开草稿：${missing.join("、")}`);
    const existing = library.find((event) => event.sources.some((src) => norm(src) === norm(row.url)));
    if (existing) {
      throw new Error(`#${number} 的原文已经在库里：${existing.id}（${existing.title}）。先改那一条，别开第二份。`);
    }

    const branch = `draft/issue-${number}`;
    const opened = await findPr(branch);
    const force = args.includes("--force");
    if (opened && !force) {
      console.log(`#${number} 已有草稿 ${opened}（要覆盖加 --force）`);
      continue;
    }

    const draft = createManualDraft({
      url: row.url,
      side: verdict.side!,
      date: verdict.date ?? (row.collectedAt || new Date().toISOString().slice(0, 10)),
      title: verdict.title_zh,
      summary: verdict.summary_zh,
      vendor: verdict.vendor,
      model: verdict.model,
      severity: verdict.side === "dark" ? verdict.severity ?? undefined : undefined,
      response: verdict.side === "dark" ? verdict.response ?? undefined : undefined,
    });
    // 预审分好的类目和信源性质，草稿阶段就带上，省得核实前再补一遍。
    const doc = parse(readFileSync(draft.path, "utf8")) as Record<string, unknown>;
    if (verdict.category.length > 0) doc.category = verdict.category;
    const source = pool.find((item) => host(item.url) === host(row.url));
    if (source?.kind === "vendor") doc.basis = "official";
    else if (source) doc.basis = "independent";
    // related 只能指向库里的明史，且不能晚于这条暗史；不合格就丢掉，别让构建失败。
    if (verdict.side === "dark" && verdict.related) {
      const parent = library.find((event) => event.id === verdict.related);
      if (!parent) console.warn(`  related ${verdict.related} 不在库里，已丢掉`);
      else if (parent.side !== "light") console.warn(`  related ${parent.id} 不是明史，已丢掉`);
      else if (parent.date > String(verdict.date ?? row.collectedAt ?? "")) console.warn(`  related ${parent.id} 晚于本条，已丢掉`);
      else doc.related = parent.id;
    }
    if (verdict.side === "dark" && !verdict.response) {
      console.log(`  #${number} 暗史没有 response（原文没写事后），PR 里会提示补一句。`);
    }
    writeFileSync(draft.path, stringify(doc, { lineWidth: 0 }));
    const content = readFileSync(draft.path, "utf8");
    const url = await pushDraft(branch, draft.path, content, number, draft.title, row.url, opened, force);
    await comment(number, [
      `已开草稿 PR：${url}`,
      "",
      `- 事件：\`${draft.id}\``,
      `- 面：${verdict.side === "dark" ? "暗史" : "明史"}`,
      `- 字段来自本地预审（依据 ${row.fetched.via === "direct" ? "全文" : "仅导语"}），\`verified\` 仍是 false。`,
      confidenceNote(verdict),
      "",
      "改完在本 PR 评论 `/核实`。合并不等于上线，还要本机 `pnpm deploy:server`。",
    ].filter(Boolean).join("\n"));
    console.log(`#${number} → ${url}`);
  }
}

function confidenceNote(verdict: Verdict): string {
  return verdict.confidence === "低" ? "- 这份预审把握是「低」（只有导语或抓取不全），摘要要重点核对。" : "";
}

async function github(path: string, method: string, body?: unknown): Promise<{ status: number; data: any }> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "liangyi-precheck/0.1",
      "x-github-api-version": "2022-11-28",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${path} → ${response.status}：${(await response.text()).slice(0, 200)}`);
  return { status: response.status, data: response.status === 204 ? null : await response.json() };
}

async function findPr(branch: string): Promise<string | undefined> {
  const owner = repo.split("/")[0];
  const { data } = await github(`/repos/${repo}/pulls?head=${owner}:${encodeURIComponent(branch)}&state=open`, "GET");
  return Array.isArray(data) && data.length > 0 ? (data[0].html_url as string) : undefined;
}

async function pushDraft(branch: string, path: string, content: string, issue: number, title: string, source: string, opened?: string, force = false): Promise<string> {
  const { data: ref } = await github(`/repos/${repo}/git/ref/heads/main`, "GET");
  const mainSha = ref.object.sha as string;
  const blob = await github(`/repos/${repo}/git/blobs`, "POST", { content, encoding: "utf8" });
  const { data: base } = await github(`/repos/${repo}/git/commits/${mainSha}`, "GET");
  const tree = await github(`/repos/${repo}/git/trees`, "POST", {
    base_tree: base.tree.sha,
    tree: [{ path, mode: "100644", type: "blob", sha: blob.data.sha }],
  });
  const commit = await github(`/repos/${repo}/git/commits`, "POST", {
    message: `起草 #${issue}：${title}`,
    tree: tree.data.sha,
    parents: [mainSha],
  });
  if (force) {
    await github(`/repos/${repo}/git/refs/heads/${branch}`, "PATCH", { sha: commit.data.sha, force: true });
    if (opened) return opened;
  } else {
    await github(`/repos/${repo}/git/refs`, "POST", { ref: `refs/heads/${branch}`, sha: commit.data.sha });
  }
  const pr = await github(`/repos/${repo}/pulls`, "POST", {
    title: `起草：${title}`.slice(0, 80),
    head: branch,
    base: "main",
    body: [
      `Closes #${issue}`,
      "",
      `source: ${source}`,
      "",
      "字段来自本地预审（`pnpm queue --draft`），`verified: false`。不要在未核对时改成 true。",
      "维护者：改完摘要和字段，在本 PR 评论 `/核实`。合并不等于上线，还要本机 `pnpm deploy:server`。",
    ].join("\n"),
  });
  return pr.data.html_url as string;
}

async function comment(issue: number, body: string) {
  await github(`/repos/${repo}/issues/${issue}/comments`, "POST", { body });
}

async function main() {
  const draftIndex = args.indexOf("--draft");
  if (draftIndex >= 0) {
    const numbers = args.slice(draftIndex + 1).filter((arg) => /^\d+$/.test(arg)).map(Number);
    await draftFromQueue(numbers);
    return;
  }
  if (args.includes("--render-only")) {
    renderOnly();
    return;
  }
  if (!apiKey) throw new Error("缺少 PRECHECK_API_KEY 或 DEEPSEEK_API_KEY。");

  const issues = (await loadIssues()).slice(0, LIMIT);
  console.log(`候选 ${issues.length} 条 · 模型 ${model} · 并发 ${CONCURRENCY} · 规则 ${prefilter.rules.length} 条`);
  const started = Date.now();
  const rows = await poolMap(issues, CONCURRENCY, one);
  console.log(`\n完成 ${((Date.now() - started) / 1000).toFixed(0)}s`);

  const order: Record<string, number> = { 收: 0, 待定: 1, 不收: 2 };
  rows.sort((a, b) => {
    const byDecision = order[a.verdict?.decision ?? "不定"] - order[b.verdict?.decision ?? "不定"];
    if (byDecision !== 0) return byDecision;
    const byBasis = (a.fetched.via === "direct" ? 0 : 1) - (b.fetched.via === "direct" ? 0 : 1);
    if (byBasis !== 0) return byBasis;
    return b.number - a.number;
  });

  mkdirSync(OUT, { recursive: true });
  const stats = summarize(rows);
  const snapshot = { generatedAt: new Date().toISOString(), model, stats, rows };
  writeFileSync(`${OUT}/queue.json`, `${JSON.stringify(snapshot, null, 2)}\n`);
  // 每次运行留一份，别让「当时为什么判不收」随下一次覆盖消失。
  mkdirSync(`${OUT}/runs`, { recursive: true });
  const stamp = snapshot.generatedAt.replace(/[:]/g, "-").slice(0, 19);
  writeFileSync(`${OUT}/runs/${stamp}.json`, `${JSON.stringify(snapshot, null, 2)}\n`);
  const history = readdirSync(`${OUT}/runs`).filter((name) => name.endsWith(".json")).sort();
  for (const stale of history.slice(0, Math.max(0, history.length - 30))) unlinkSync(`${OUT}/runs/${stale}`);
  writeFileSync(`${OUT}/report.md`, renderMarkdown(rows, stats));
  writeFileSync(`${OUT}/index.html`, renderHtml(rows, stats));
  console.log(`收 ${stats.收} · 待定 ${stats.待定} · 不收 ${stats.不收} · 全文 ${stats.fullText} · 仅导语 ${stats.lede} · 没取到 ${stats.none}`);
  console.log(`预审台：${OUT}/index.html`);
  console.log(`队列：${OUT}/queue.json`);
}

function summarize(rows: Row[]) {
  const count = (decision: Decision) => rows.filter((row) => row.verdict?.decision === decision).length;
  // 规则丢弃的行本来就不抓，不计入抓取统计。
  const fetched = rows.filter((row) => row.fetched.note !== "规则丢弃，未抓取");
  return {
    收: count("收"),
    待定: count("待定"),
    不收: count("不收"),
    rules: rows.filter((row) => row.rule?.action === "drop").length,
    fullText: fetched.filter((row) => row.fetched.via === "direct").length,
    lede: fetched.filter((row) => row.fetched.via === "feed").length,
    none: fetched.filter((row) => row.fetched.via === "none").length,
    errors: rows.filter((row) => row.error).length,
    seconds: Math.round(rows.reduce((sum, row) => sum + row.seconds, 0)),
  };
}

function action(row: Row): string {
  const decision = row.verdict?.decision;
  if (decision === "收") return row.verdict?.side === "dark" ? "/收 暗" : "/收 明";
  return "/丢";
}

function renderMarkdown(rows: Row[], stats: ReturnType<typeof summarize>): string {
  const lines = [
    "# 预审台",
    "",
    `${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · 收 ${stats.收} · 待定 ${stats.待定} · 不收 ${stats.不收}`,
    `全文 ${stats.fullText} · 仅导语 ${stats.lede} · 没取到 ${stats.none} · 出错 ${stats.errors}`,
    "",
    "> 这一层只决定「要不要」，不改 `verified`。收 → `/收` → 草稿 PR → `pnpm review` → `/核实`。",
    "",
  ];
  const section = (name: string, decision: Decision) => {
    const list = rows.filter((row) => row.verdict?.decision === decision);
    if (list.length === 0) return;
    lines.push(`## ${name}（${list.length}）`, "");
    for (const row of list) {
      const verdict = row.verdict;
      lines.push(`- [#${row.number}](${row.issueUrl}) ${verdict?.title_zh || row.title} — ${verdict?.why ?? row.error}`);
      if (verdict?.summary_zh) lines.push(`  - ${verdict.summary_zh}`);
      lines.push(`  - 依据 ${row.fetched.via === "direct" ? "全文" : row.fetched.via === "feed" ? "仅导语" : "没取到"} · ${row.url} · \`${action(row)}\``);
    }
    lines.push("");
  };
  section("建议收", "收");
  section("待定", "待定");
  section("建议不收", "不收");
  return `${lines.join("\n")}\n`;
}

function renderHtml(rows: Row[], stats: ReturnType<typeof summarize>): string {
  const cards = rows.map((row) => card(row)).join("\n");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>两仪 · 预审台</title>
<style>
  :root {
    --ink: #1b1a17; --paper: #f6f2e9; --paper-2: #fffdf7; --line: #d9d1c0;
    --light: #8a6a1f; --dark: #8f2f24; --muted: #7a7266; --hold: #3f5a52;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink);
    font: 15px/1.65 "LXGW WenKai Screen", -apple-system, "PingFang SC", "Songti SC", serif; }
  header { position: sticky; top: 0; z-index: 5; background: rgba(246,242,233,.94);
    border-bottom: 1px solid var(--line); padding: 18px 28px; backdrop-filter: blur(6px); }
  h1 { margin: 0 0 6px; font-size: 19px; letter-spacing: .2em; font-weight: 600; }
  .meta { color: var(--muted); font-size: 13px; }
  .counts { display: flex; gap: 18px; margin-top: 10px; font-size: 13px; flex-wrap: wrap; }
  .counts b { font-size: 16px; margin-right: 2px; }
  .counts .c-shou b { color: var(--dark); } .counts .c-dai b { color: var(--hold); } .counts .c-bu b { color: var(--muted); }
  .toolbar { margin-left: auto; display: flex; gap: 12px; align-items: center; font-size: 13px; color: var(--muted); }
  .row { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
  main { padding: 22px 28px 80px; max-width: 900px; }
  .card { background: var(--paper-2); border: 1px solid var(--line); border-radius: 3px;
    padding: 16px 18px; margin-bottom: 14px; position: relative; }
  .card[data-d="不收"] { opacity: .55; }
  .card[data-d="不收"]:hover { opacity: 1; }
  .card h2 { margin: 0 0 6px; font-size: 16px; font-weight: 600; line-height: 1.45; }
  .badge { display: inline-block; font-size: 12px; padding: 1px 7px; border: 1px solid currentColor;
    border-radius: 2px; letter-spacing: .08em; vertical-align: 2px; margin-right: 8px; }
  .b-收 { color: var(--dark); } .b-待定 { color: var(--hold); } .b-不收 { color: var(--muted); }
  .face { font-size: 12px; color: var(--muted); }
  .why { margin: 8px 0 0; }
  .sum { margin: 6px 0 0; color: #33302a; }
  .facts { margin-top: 10px; font-size: 12.5px; color: var(--muted); display: flex; gap: 14px; flex-wrap: wrap; }
  .facts a { color: inherit; }
  .chip { border: 1px solid var(--line); border-radius: 2px; padding: 0 6px; }
  .chip.warn { border-color: #c8a86a; color: #8a6a1f; }
  .acts { position: absolute; right: 16px; top: 14px; display: flex; gap: 6px; }
  button { font: inherit; font-size: 12.5px; padding: 3px 10px; background: transparent; color: var(--ink);
    border: 1px solid var(--line); border-radius: 2px; cursor: pointer; }
  button:hover { border-color: var(--ink); }
  button.on { background: var(--ink); color: var(--paper); border-color: var(--ink); }
  .dup { color: var(--dark); }
  .empty { color: var(--muted); }
  @media (max-width: 620px) { .acts { position: static; margin-top: 10px; } }
</style>
</head>
<body>
<header>
  <div class="row">
    <div>
      <h1>两仪 · 预审台</h1>
      <div class="meta">${new Date().toLocaleString("zh-CN", { hour12: false })} · 模型 ${escapeHtml(model)} · 规则先砍 ${stats.rules} · 抓取 全文 ${stats.fullText} / 仅导语 ${stats.lede} / 没取到 ${stats.none}</div>
    </div>
    <label class="toolbar"><input type="checkbox" id="only"> 只看建议收</label>
  </div>
  <div class="counts">
    <span class="c-shou"><b>${stats.收}</b>建议收</span>
    <span class="c-dai"><b>${stats.待定}</b>待定</span>
    <span class="c-bu"><b>${stats.不收}</b>建议不收</span>
    <span>出错 <b>${stats.errors}</b></span>
  </div>
</header>
<main>
${cards || '<p class="empty">没有开放候选。</p>'}
</main>
<script>
  const only = document.getElementById("only");
  only.addEventListener("change", () => {
    document.querySelectorAll(".card").forEach((card) => {
      card.style.display = only.checked && card.dataset.d !== "收" ? "none" : "";
    });
  });
  document.querySelectorAll("button[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const text = button.dataset.copy;
      try { await navigator.clipboard.writeText(text); } catch { prompt("复制：", text); return; }
      const old = button.textContent;
      button.textContent = "已复制";
      button.classList.add("on");
      setTimeout(() => { button.textContent = old; button.classList.remove("on"); }, 1200);
    });
  });
</script>
</body>
</html>
`;
}

function card(row: Row): string {
  const verdict = row.verdict;
  const decision = verdict?.decision ?? "待定";
  const face = verdict?.side === "dark" ? "暗史" : verdict?.side === "light" ? "明史" : "";
  const basis = row.fetched.via === "direct" ? "全文" : row.fetched.via === "feed" ? "仅导语" : "没取到";
  const facts = [
    verdict?.vendor ? escapeHtml(`${verdict.vendor}${verdict.model ? ` ${verdict.model}` : ""}`) : "",
    verdict?.date ? escapeHtml(verdict.date) : "",
    row.collectedAt ? `采集 ${escapeHtml(row.collectedAt.slice(0, 16))}` : "",
    `<span class="chip ${row.fetched.via === "direct" ? "" : "warn"}">${basis}</span>`,
    verdict ? `把握 ${escapeHtml(verdict.confidence)}` : "",
    verdict?.severity ? `严重 ${verdict.severity}` : "",
    verdict?.dup_of ? `<span class="dup">已在库 ${escapeHtml(verdict.dup_of)}</span>` : "",
  ].filter(Boolean);
  const title = verdict?.title_zh || row.title;
  return `<article class="card" data-d="${decision}">
  <div class="acts">
    ${decision === "收" ? `<button data-copy="${action(row)}">复制 ${action(row)}</button>` : ""}
    <button data-copy="/丢">复制 /丢</button>
    <a href="${escapeHtml(row.issueUrl)}" target="_blank" rel="noreferrer"><button>issue #${row.number}</button></a>
  </div>
  <h2><span class="badge b-${decision}">${decision}</span>${escapeHtml(title)}${face ? ` <span class="face">${face}</span>` : ""}</h2>
  ${verdict?.summary_zh ? `<p class="sum">${escapeHtml(verdict.summary_zh)}</p>` : ""}
  <p class="why">${escapeHtml(verdict?.why ?? row.error ?? "")}</p>
  <div class="facts">
    ${facts.map((fact) => `<span>${fact}</span>`).join("")}
    <a href="${escapeHtml(row.url)}" target="_blank" rel="noreferrer">原文</a>
  </div>
</article>`;
}

function escapeHtml(value: string): string {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

await main();
