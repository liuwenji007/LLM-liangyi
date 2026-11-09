import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";

export type PrefilterRule = { id: string; why: string; action: "drop" | "hold"; url?: string; title?: string };
export type PrefilterKeep = { why: string; url?: string; title?: string };
export type Prefilter = { rules: PrefilterRule[]; keep: PrefilterKeep[] };
export type PrefilterHit = { id: string; action: "drop" | "hold"; why: string };

const PATH = "src/data/prefilter.yaml";

export function loadPrefilter(path = PATH): Prefilter {
  if (!existsSync(path)) return { rules: [], keep: [] };
  const data = (parse(readFileSync(path, "utf8")) ?? {}) as Partial<Prefilter>;
  return { rules: data.rules ?? [], keep: data.keep ?? [] };
}

/**
 * 命中 keep 一律保留（防误杀），否则返回第一条命中的规则。
 */
export function matchPrefilter(filter: Prefilter, item: { title: string; url: string }): PrefilterHit | null {
  const test = (pattern: string | undefined, value: string) => (pattern ? new RegExp(pattern, "i").test(value) : false);
  for (const keep of filter.keep) {
    if (test(keep.url, item.url) || test(keep.title, item.title)) return null;
  }
  for (const rule of filter.rules) {
    if (test(rule.url, item.url) || test(rule.title, item.title)) {
      return { id: rule.id, action: rule.action === "hold" ? "hold" : "drop", why: rule.why };
    }
  }
  return null;
}
