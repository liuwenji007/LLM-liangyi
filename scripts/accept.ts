import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { parse } from "yaml";
import { createDraft, type DraftSide } from "./draft.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const EVENTS = "src/data/events";
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const event = loadEvent();
const command = readCommand(event?.comment?.body ?? process.argv.slice(2).join(" "));
const allowed = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

if (!command) {
  console.log("不是 /收 或 /丢，忽略。");
  process.exit(0);
}
if (!event?.issue || event.issue.pull_request) {
  console.log("只处理 Issue 评论，不处理 PR。");
  process.exit(0);
}

const issue = event.issue.number;
const association = event.comment?.author_association ?? "";
if (!allowed.has(association)) {
  await comment(issue, "只有维护者可以 `/收` 或 `/丢`。");
  process.exit(0);
}

if (!isCandidate(event.issue)) {
  await comment(issue, "这不是候选 Issue。`/收` 和 `/丢` 只用于带 `候选/编年` 或 `候选/乐子` 的帖。");
  process.exit(0);
}

if (command.action === "丢") {
  await comment(issue, "已按维护者指示关闭。");
  await github(`/repos/${repo}/issues/${issue}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });
  console.log(`已关闭 #${issue}`);
  process.exit(0);
}

if (isFun(event.issue)) {
  await comment(issue, "乐子还没有独立目录，现在不能 `/收` 进编年。先 `/丢` 关掉，或等到 fun 赛道落地。");
  process.exit(0);
}

const parsed = parseIssue(event.issue.body ?? "", event.issue.title ?? "");
const side = command.side ?? parsed.side;
if (!parsed.url) {
  await comment(issue, "正文里没有 `source:` 链接，无法起草。");
  process.exit(0);
}
if (!side) {
  await comment(
    issue,
    [
      "建议面还是「待定」，不会默认按暗史起草。",
      "",
      "再评论一次，写明面：",
      "- `/收 明` 或 `/收 明史`",
      "- `/收 暗` 或 `/收 暗史`",
    ].join("\n"),
  );
  process.exit(0);
}

const already = knownEvent(parsed.url);
if (already) {
  await comment(issue, `这个链接已经在 \`${already}\` 里。不要再起草一份。不需要就 \`/丢\`。`);
  process.exit(0);
}

const branch = `draft/issue-${issue}`;
const existing = existingPr(branch);
if (existing) {
  await comment(issue, `已经有草稿 PR：${existing}`);
  process.exit(0);
}

let draft;
try {
  draft = await createDraft({
    url: parsed.url,
    side,
    date: parsed.date,
    title: parsed.title,
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await comment(issue, `没有开 PR：${message}\n\n抓不到页面就先不要起草。可以稍后重试 \`/收\`，或本地 \`pnpm draft ${parsed.url}\`。`);
  process.exit(0);
}

if (!token || !repo) {
  console.log(draft.path);
  process.exit(0);
}

const check = runCheck();
let pr: string;
try {
  pushBranch(branch, draft.path, issue);
  pr = createPr(branch, issue, draft, parsed.url);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await comment(
    issue,
    [
      `草稿文件写出来了，但没建成 PR：${message}`,
      "",
      `分支名：\`${branch}\``,
      "可以再评论一次 `/收` 重试（会覆盖这条草稿分支）。",
    ].join("\n"),
  );
  process.exit(1);
}

const review = runReview(draft.id);
const notes = [
  `已开草稿 PR：${pr}`,
  "",
  `- 事件：\`${draft.id}\``,
  `- 面：${draft.side === "dark" ? "暗史" : "明史"}`,
  draft.side === "dark" ? "- 暗史还要补 `severity`。默认 token 开的 PR 不会跑 CI，合并前请在本机 `pnpm check`。" : "- 默认 token 开的 PR 不会跑 CI。合并前建议本机 `pnpm check`。",
  "- `verified` 仍是 false。核对完你在 PR 里改成 true 再合并。",
  check,
  "",
  "审查报告贴在 PR 里。",
].join("\n");

try {
  await comment(pr, `${review}\n\n${check}`);
} catch (error) {
  console.warn("没能评论 PR。", error);
}
await comment(issue, notes);
console.log(pr);

type IssueEvent = {
  comment?: { body?: string; author_association?: string };
  issue?: {
    number: number;
    title?: string;
    body?: string;
    pull_request?: unknown;
    labels?: { name?: string }[];
  };
};

function loadEvent(): IssueEvent | undefined {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path || !existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as IssueEvent;
}

function readCommand(body: string): { action: "收"; side?: DraftSide } | { action: "丢" } | undefined {
  const line = body.trim().split(/\r?\n/)[0]?.trim() ?? "";
  if (line === "/丢") return { action: "丢" };
  const match = /^\/收(?:\s+(明史|暗史|明|暗))?$/.exec(line);
  if (!match) return undefined;
  const face = match[1];
  const side = face === "明史" || face === "明" ? "light" : face === "暗史" || face === "暗" ? "dark" : undefined;
  return { action: "收", side };
}

function candidateLabels(issue: NonNullable<IssueEvent["issue"]>): string[] {
  return (issue.labels ?? []).map((label) => label.name ?? "");
}

function isCandidate(issue: NonNullable<IssueEvent["issue"]>): boolean {
  const labels = candidateLabels(issue);
  return labels.includes("候选/编年") || labels.includes("候选/乐子") || /^候选[：:]/.test(issue.title ?? "");
}

function isFun(issue: NonNullable<IssueEvent["issue"]>): boolean {
  if (candidateLabels(issue).includes("候选/乐子")) return true;
  return /分级：\s*乐子/.test(issue.body ?? "");
}

function parseIssue(body: string, title: string): { url?: string; side?: DraftSide; date?: string; title?: string } {
  const source = /^source:\s*(\S+)/m.exec(body)?.[1];
  const fallback = body.match(/https?:\/\/[^\s)>]+/)?.[0];
  const face = /建议面：\s*(明史|暗史)/.exec(body)?.[1];
  const date = /日期：\s*(\d{4}-\d{2}-\d{2})/.exec(body)?.[1];
  const name = title.replace(/^候选：\s*/, "").trim();
  return {
    url: source || fallback,
    side: face === "明史" ? "light" : face === "暗史" ? "dark" : undefined,
    date,
    title: name || undefined,
  };
}

function knownEvent(url: string): string | undefined {
  const target = norm(url);
  if (!existsSync(EVENTS)) return undefined;
  for (const file of readdirSync(EVENTS).filter((name) => name.endsWith(".yaml"))) {
    const data = parse(readFileSync(`${EVENTS}/${file}`, "utf8")) as { sources?: { url?: string }[] };
    for (const source of data.sources ?? []) {
      if (source.url && norm(source.url) === target) return file.replace(/\.yaml$/, "");
    }
  }
  return undefined;
}

function existingPr(branch: string): string | undefined {
  if (!repo) return undefined;
  try {
    const output = execFileSync("gh", ["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "url", "--jq", ".[0].url"], {
      encoding: "utf8",
    }).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

function pushBranch(branch: string, file: string, issue: number) {
  execFileSync("git", ["config", "user.name", "github-actions[bot]"]);
  execFileSync("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
  execFileSync("git", ["checkout", "-B", branch]);
  execFileSync("git", ["add", "--", file]);
  execFileSync("git", ["commit", "-m", `起草候选 #${issue}`]);
  execFileSync("git", ["push", "-u", "origin", `HEAD:${branch}`, "--force"], { stdio: "inherit" });
}

function createPr(branch: string, issue: number, draft: { id: string; title: string; side: DraftSide }, url: string): string {
  const opened = existingPr(branch);
  if (opened) return opened;
  const body = [
    `Closes #${issue}`,
    "",
    `source: ${url}`,
    "",
    "自动起草，`verified: false`。不要在未核对时改成 true。",
    draft.side === "dark" ? "暗史必须补 `severity`（1–5），必要时补 `related` / `response`。默认 token 开的 PR 不会跑 CI。" : "默认 token 开的 PR 不会跑 CI，合并前建议 `pnpm check`。",
    "",
    "维护者：改完摘要和字段，把 `verified` 改成 `true`，再合并。",
  ]
    .filter(Boolean)
    .join("\n");
  return execFileSync(
    "gh",
    ["pr", "create", "--repo", repo!, "--head", branch, "--title", `起草：${draft.title}`.slice(0, 80), "--body", body],
    { encoding: "utf8" },
  ).trim();
}

function runReview(id: string): string {
  if (!process.env.DEEPSEEK_API_KEY) return "没有 DEEPSEEK_API_KEY，跳过对照原文。请在 PR 里人工核对。";
  try {
    execFileSync("pnpm", ["review", id], { stdio: "inherit" });
    return existsSync("reports/review/report.md")
      ? readFileSync("reports/review/report.md", "utf8")
      : "审查跑完了，但没有报告文件。";
  } catch (error) {
    return `审查没有跑完：${error instanceof Error ? error.message : error}`;
  }
}

function runCheck(): string {
  try {
    execFileSync("pnpm", ["check"], { stdio: "pipe", encoding: "utf8" });
    return "- `pnpm check` 通过。";
  } catch (error) {
    const output = error && typeof error === "object" && "stdout" in error ? String((error as { stdout: string }).stdout) : "";
    const hint = output.includes("严重程度") || output.includes("severity") ? "多半是暗史还没写 severity。" : "合并会让主分支 CI 失败。";
    return `- \`pnpm check\` 未通过。${hint} 先改 PR 再合并。`;
  }
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

async function comment(target: number | string, body: string) {
  if (!token || !repo) {
    console.log(body);
    return;
  }
  if (typeof target === "string" && target.startsWith("http")) {
    execFileSync("gh", ["pr", "comment", target, "--body", body], { stdio: "inherit" });
    return;
  }
  await github(`/repos/${repo}/issues/${target}/comments`, { method: "POST", body: JSON.stringify({ body }) });
}

async function github(path: string, init: RequestInit = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "liangyi-accept/0.1",
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub ${response.status}：${(await response.text()).slice(0, 200)}`);
  return response.json();
}
