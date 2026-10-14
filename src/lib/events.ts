import { existsSync } from "node:fs";
import { getCollection, type CollectionEntry } from "astro:content";

export type EventEntry = CollectionEntry<"events">;

export type TimelineNode = {
  entry: EventEntry;
  parent?: { id: string; model: string; days: number };
  fallout: { id: string; title: string; days: number; severity: number }[];
};

export type YearGroup = { year: number; nodes: TimelineNode[] };

const DAY_MS = 86_400_000;

export const PIP_SIZE: Record<number, number> = { 1: 6, 2: 8, 3: 10, 4: 13, 5: 16 };

export function formatDate(date: Date): string {
  return isoDate(date).replaceAll("-", ".");
}

export function ganzhi(year: number): string {
  return "甲乙丙丁戊己庚辛壬癸"[(year - 4) % 10] + "子丑寅卯辰巳午未申酉戌亥"[(year - 4) % 12];
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function daysBetween(from: Date, to: Date): number {
  return Math.round((Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()) -
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())) / DAY_MS);
}

export function relationText(model: string, days: number): string {
  if (days === 0) return `${model} 发布当天`;
  if (days < 60) return `${model} 发布后第 ${days} 天`;
  return `${model} 发布后约 ${Math.round(days / 30.4)} 个月`;
}

export function tagLabel(category: string): string | undefined {
  if (category === "误用") return "误用";
  if (category === "自披露") return "厂商自披露";
  return undefined;
}

export async function buildTimeline(): Promise<TimelineNode[]> {
  const all = await getCollection("events");
  const byId = new Map(all.map((entry) => [entry.id, entry]));
  const verified = all.filter((entry) => entry.data.verified);
  const errors: string[] = [];

  for (const entry of all) {
    const { related, memes } = entry.data;
    if (related) {
      const parent = byId.get(related);
      if (!parent) errors.push(`${entry.id}: related 指向的 ${related} 不存在`);
      else if (parent.data.side !== "light") errors.push(`${entry.id}: related 指向的 ${related} 不是明史`);
      else if (entry.data.date < parent.data.date) errors.push(`${entry.id}: 暗史日期早于 ${related}`);
      else if (parent.data.vendor !== entry.data.vendor) {
        console.warn(`[两仪] ${entry.id} 与 ${related} 厂商不同（${entry.data.vendor} / ${parent.data.vendor}）`);
      }
    }
    for (const meme of memes) {
      if (!existsSync(`public/memes/${entry.id}/${meme.file}`)) {
        errors.push(`${entry.id}: 梗图 public/memes/${entry.id}/${meme.file} 不存在`);
      }
    }
  }

  if (errors.length > 0) throw new Error(`事件数据校验失败：\n${errors.join("\n")}`);

  const nodes = new Map<string, TimelineNode>(verified.map((entry) => [entry.id, { entry, fallout: [] }]));

  for (const node of nodes.values()) {
    const { related } = node.entry.data;
    if (!related) continue;
    const parent = nodes.get(related);
    if (!parent) continue;
    const days = daysBetween(parent.entry.data.date, node.entry.data.date);
    node.parent = { id: parent.entry.id, model: parent.entry.data.model, days };
    parent.fallout.push({
      id: node.entry.id,
      title: node.entry.data.title,
      days,
      severity: node.entry.data.severity ?? 1,
    });
  }

  for (const node of nodes.values()) node.fallout.sort((a, b) => a.days - b.days);

  return [...nodes.values()].sort((a, b) => {
    const diff = b.entry.data.date.getTime() - a.entry.data.date.getTime();
    if (diff !== 0) return diff;
    if (a.entry.data.side === b.entry.data.side) return 0;
    return a.entry.data.side === "dark" ? -1 : 1;
  });
}

export function groupByYear(nodes: TimelineNode[]): YearGroup[] {
  const groups: YearGroup[] = [];
  for (const node of nodes) {
    const year = node.entry.data.date.getUTCFullYear();
    const last = groups.at(-1);
    if (last?.year === year) last.nodes.push(node);
    else groups.push({ year, nodes: [node] });
  }
  return groups;
}
