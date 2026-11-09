import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";

export type PrefilterRule = { id: string; why: string; action: "drop" | "hold"; url?: string; title?: string };
export type PrefilterKeep = { why: string; url?: string; title?: string };
export type Prefilter = { rules: PrefilterRule[]; keep: PrefilterKeep[] };
export type PrefilterHit = { id: string; action: "drop" | "hold"; why: string; matched: "url" | "title" };

const PATH = "src/data/prefilter.yaml";

export function loadPrefilter(path = PATH): Prefilter {
  if (!existsSync(path)) return { rules: [], keep: [] };
  const data = (parse(readFileSync(path, "utf8")) ?? {}) as Partial<Prefilter>;
  return { rules: data.rules ?? [], keep: data.keep ?? [] };
}

/**
 * 命中规则就返回它；`keep` 只豁免与它同类的那一半。
 *
 * - keep 写 url：豁免全部规则（显式例外，最优先）。
 * - keep 写 title：只豁免由标题触发的规则，URL 规则照旧生效。
 *   否则「Introducing Gemini for Education」会被 keep 放行，
 *   从教育栏目那条 URL 规则底下逃出去。
 *
 * 规则同时写了 url 和 title 时，URL 命中优先判定。
 */
export function matchPrefilter(filter: Prefilter, item: { title: string; url: string }): PrefilterHit | null {
  const test = (pattern: string | undefined, value: string) => (pattern ? new RegExp(pattern, "i").test(value) : false);

  if (filter.keep.some((keep) => test(keep.url, item.url))) return null;
  const keepTitle = filter.keep.some((keep) => test(keep.title, item.title));

  for (const rule of filter.rules) {
    const byUrl = test(rule.url, item.url);
    const byTitle = test(rule.title, item.title);
    if (!byUrl && !byTitle) continue;
    const action = rule.action === "hold" ? "hold" : "drop";
    if (byUrl) return { id: rule.id, action, why: rule.why, matched: "url" };
    if (keepTitle) continue;
    return { id: rule.id, action, why: rule.why, matched: "title" };
  }
  return null;
}
