import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

const CANDIDATES = "reports/collect/candidates.json";
const OUT = "reports/collect";
const CHRONICLE_LIMIT = 5;
const LABELS = {
  chronicle: "候选/编年",
  fun: "候选/乐子",
} as const;

type Lane = "chronicle" | "fun" | "drop";
type Hit = { title: string; url: string; date: string; via: string; tier: number; lane: string; summary?: string };
type Mark = { url: string; lane: Lane; side: "light" | "dark" | null; reason: string };
type Issue = { body?: string; pull_request?: unknown };

const apiKey = process.env.DEEPSEEK_API_KEY;
const baseUrl = (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/$/, "");
const model = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

if (!apiKey) {
  console.error("缺少 DEEPSEEK_API_KEY。复制 .env.example 为 .env 并填上 key。");
  process.exit(1);
}
if (!existsSync(CANDIDATES)) {
  console.error(`找不到 ${CANDIDATES}。先运行 pnpm collect。`);
  process.exit(1);
}

const file = JSON.parse(readFileSync(CANDIDATES, "utf8")) as { items?: Hit[] };
const items = file.items ?? [];
const marks = new Map<string, Mark>();

for (const chunk of chunks(items, 20)) {
  const batch = await classify(chunk);
  chunk.forEach((item, index) => {
    const mark = batch.find((row) => norm(row.url) === norm(item.url)) ?? batch[index];
    if (!mark) return;
    marks.set(norm(item.url), { ...mark, url: item.url });
  });
}

const chronicle: Hit[] = [];
const fun: Hit[] = [];
const dropped: Hit[] = [];
for (const item of items) {
  const mark = marks.get(norm(item.url));
  const lane = mark?.lane ?? "drop";
  if (lane === "chronicle") chronicle.push(item);
  else if (lane === "fun") fun.push(item);
  else dropped.push(item);
}
chronicle.sort((a, b) => a.tier - b.tier || b.date.localeCompare(a.date));
fun.sort((a, b) => a.tier - b.tier || b.date.localeCompare(a.date));

const repo = repository();
const opened: { lane: Lane; url: string; number?: number; skipped?: string }[] = [];

if (!token || !repo) {
  console.warn("没有 GITHUB_TOKEN 或仓库地址，只写报告，不开 Issue。");
} else {
  await ensureLabels(repo);
  const existing = await openIssueBodies(repo);
  await openLimited(repo, chronicle, "chronicle", CHRONICLE_LIMIT, existing, opened);
  for (const item of fun) {
    opened.push({ lane: "fun", url: norm(item.url), skipped: "乐子赛道未落地，不开 Issue" });
  }
}

mkdirSync(OUT, { recursive: true });
const report = {
  generatedAt: new Date().toISOString(),
  counts: { chronicle: chronicle.length, fun: fun.length, drop: dropped.length, opened: opened.filter((row) => row.number).length },
  opened,
  held: {
    chronicle: chronicle.slice(CHRONICLE_LIMIT).map((item) => item.url),
    fun: fun.map((item) => item.url),
  },
  dropped: dropped.map((item) => ({ url: item.url, reason: marks.get(norm(item.url))?.reason ?? "未分类" })),
};
writeFileSync(`${OUT}/triage.json`, JSON.stringify(report, null, 2));
writeFileSync(`${OUT}/triage.md`, render(chronicle, fun, dropped));
console.log(
  `粗分 编年 ${chronicle.length} · 乐子 ${fun.length} · 丢弃 ${dropped.length} · 新开 Issue ${report.counts.opened}`,
);
console.log(`报告 ${OUT}/triage.md`);

async function classify(batch: Hit[]): Promise<Mark[]> {
  const body = JSON.stringify({
    model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "你在给「两仪」时间线做入库前粗分。只输出 JSON：{\"items\":[{\"url\":\"\",\"lane\":\"chronicle|fun|drop\",\"side\":\"light|dark|null\",\"reason\":\"一句中文\"}]}。",
          "chronicle：能核对的发布、能力宣称、事故、监管、用户公开反馈。light 是厂商发布或能力宣称，dark 是翻车或用户侧后果。",
          "fun：梗图、八卦、二创、传播向趣闻。不进编年主轴。",
          "drop：与大模型无关、纯广告、人身攻击、无法判断的水文。",
          "不要建议把任何条目标成已核实。",
        ].join("\n"),
      },
      {
        role: "user",
        content: batch
          .map((item, index) => `${index + 1}. ${item.title}\nurl: ${item.url}\nvia: ${item.via}\ndate: ${item.date}\n${item.summary ?? ""}`)
          .join("\n\n"),
      },
    ],
  });
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) throw new Error(`粗分接口返回 ${response.status}`);
  const data = (await response.json()) as { choices: { message: { content: string } }[] };
  const parsed = JSON.parse(data.choices[0].message.content) as { items?: Mark[] };
  return (parsed.items ?? []).map((item) => ({
    url: item.url,
    lane: item.lane === "chronicle" || item.lane === "fun" ? item.lane : "drop",
    side: item.side === "light" || item.side === "dark" ? item.side : null,
    reason: item.reason || "",
  }));
}

async function openLimited(
  repoName: string,
  list: Hit[],
  lane: "chronicle" | "fun",
  limit: number,
  existing: Set<string>,
  log: { lane: Lane; url: string; number?: number; skipped?: string }[],
) {
  let created = 0;
  for (const item of list) {
    const url = norm(item.url);
    if (existing.has(url)) {
      log.push({ lane, url, skipped: "已有 Issue" });
      continue;
    }
    if (created >= limit) {
      log.push({ lane, url, skipped: "超出当日限额" });
      continue;
    }
    const mark = marks.get(url);
    const number = await createIssue(repoName, item, lane, mark);
    existing.add(url);
    created += 1;
    log.push({ lane, url, number });
  }
}

async function createIssue(repoName: string, item: Hit, lane: "chronicle" | "fun", mark?: Mark): Promise<number> {
  const side = mark?.side === "dark" ? "暗史" : mark?.side === "light" ? "明史" : "待定";
  const response = await github(`/repos/${repoName}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: `候选：${item.title}`.slice(0, 120),
      labels: [LABELS[lane]],
      body: [
        `source: ${norm(item.url)}`,
        "",
        `- 来自：${item.via}`,
        `- 日期：${item.date || "未知"}`,
        `- 分级：${lane === "chronicle" ? "编年" : "乐子"}`,
        `- 建议面：${side}`,
        `- 理由：${mark?.reason || "无"}`,
        item.summary ? `- 摘要：${item.summary}` : "",
        "",
        "这是候选，不是已核实条目。不要把 `verified` 改成 true，除非人工核对通过。",
        "",
        "下一步（维护者评论）：",
        "",
        "- `/收`：建议面已是明/暗时，云端起草并开 PR。已有草稿时请新发一条，编辑旧评论不会更新",
        "- `/收 明` 或 `/收 暗`：建议面待定时必须写明",
        "- 官网拒抓：有导语时会用导语起草。要改依据，评论里写 `依据: 官方` 或 `依据: 第三方`",
        "- 草稿 PR 上评论 `/核实`：`pnpm check` 通过后把 `verified` 改成 true。不合并不部署",
        "- `/丢`：关闭这条候选",
        "",
        "本机也可以：",
        "",
        "```bash",
        `pnpm draft ${item.url}`,
        "```",
      ]
        .filter(Boolean)
        .join("\n"),
    }),
  });
  return response.number as number;
}

async function ensureLabels(repoName: string) {
  const specs = [
    { name: LABELS.chronicle, color: "a5322b", description: "编年候选，每天最多 5 条，核实前不上线" },
    { name: LABELS.fun, color: "c9a874", description: "乐子候选，每天最多 10 条，不进编年主轴" },
  ];
  for (const spec of specs) {
    const response = await fetch(`https://api.github.com/repos/${repoName}/labels/${encodeURIComponent(spec.name)}`, {
      headers: githubHeaders(),
    });
    if (response.ok) continue;
    await github(`/repos/${repoName}/labels`, { method: "POST", body: JSON.stringify(spec) });
  }
}

async function openIssueBodies(repoName: string): Promise<Set<string>> {
  const urls = new Set<string>();
  for (let page = 1; page <= 10; page += 1) {
    const list = (await github(`/repos/${repoName}/issues?state=all&per_page=100&page=${page}`)) as Issue[];
    if (!Array.isArray(list) || list.length === 0) break;
    for (const issue of list) {
      if (issue.pull_request || !issue.body) continue;
      const match = /^source:\s*(\S+)/m.exec(issue.body);
      if (match) urls.add(norm(match[1]));
    }
    if (list.length < 100) break;
  }
  return urls;
}

function repository(): string | undefined {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
    const match = /github\.com[:/]([^/]+\/[^/.]+)/.exec(remote);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function githubHeaders(): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "liangyi-triage/0.1",
    "x-github-api-version": "2022-11-28",
  };
}

async function github(path: string, init: RequestInit = {}): Promise<Issue & { number?: number }> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { ...githubHeaders(), ...(init.body ? { "content-type": "application/json" } : {}) },
  });
  if (!response.ok) throw new Error(`GitHub ${response.status}：${(await response.text()).slice(0, 200)}`);
  return response.json() as Promise<Issue & { number?: number }>;
}

function render(chronicleList: Hit[], funList: Hit[], droppedList: Hit[]): string {
  const lines = [
    "# 粗分结果",
    "",
    `${new Date().toISOString()} · 编年 ${chronicleList.length} · 乐子 ${funList.length} · 丢弃 ${droppedList.length}`,
    "",
    `开 Issue 上限：编年 ${CHRONICLE_LIMIT}。乐子赛道未落地，不开 Issue，只留在本报告。`,
    "超出编年限额、且仍在收集窗口内的，下次定时任务会再排队。不会修改 verified。",
    "「开」表示落在当日限额内；是否真的新建，以 triage.json 的 opened 为准。",
    "",
    "## 编年",
    "",
    ...section(chronicleList, CHRONICLE_LIMIT),
    "",
    "## 乐子",
    "",
    "乐子赛道未落地，不开 Issue。",
    "",
    ...section(funList, 0),
    "",
    "## 丢弃",
    "",
    ...droppedList.map((item) => `- ${item.title} — ${marks.get(norm(item.url))?.reason || ""} ${item.url}`),
    "",
  ];
  return lines.join("\n");
}

function section(list: Hit[], limit: number): string[] {
  if (!list.length) return ["无"];
  return list.map((item, index) => {
    const mark = marks.get(norm(item.url));
    const cap = index < limit ? "开" : "留";
    return `- [${cap}] ${item.date || "—"} ${item.title}（${mark?.side ?? "待定"}）${item.url}`;
  });
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size));
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
