export type Side = "light" | "dark";

export type HistoryState = {
  anchorId?: string;
  anchorTop?: number;
  center?: boolean;
};

export const root = document.documentElement;

export const nodes = [...document.querySelectorAll<HTMLElement>(".node")];
export const nodeById = new Map(nodes.map((node) => [node.dataset.id ?? "", node]));
export const vendors = new Set(
  [...document.querySelectorAll<HTMLButtonElement>("[data-vendor-choice]")]
    .map((button) => button.dataset.vendorChoice ?? "")
    .filter(Boolean),
);

let vendor = "";

export function currentSide(): Side {
  return root.dataset.side === "dark" ? "dark" : "light";
}

export function getVendor(): string {
  return vendor;
}

export function setVendor(next: string) {
  vendor = next;
}

export function readUrl(): { side: Side | null; vendor: string; hash: string } {
  const params = new URLSearchParams(location.search);
  const side = params.get("side") === "dark" ? "dark" : params.has("side") ? "light" : null;
  const candidate = params.get("vendor") ?? "";
  return {
    side,
    vendor: vendors.has(candidate) ? candidate : "",
    hash: decodeURIComponent(location.hash.slice(1)),
  };
}

export function writeUrl({ push = false, hash = "", state = {} }: { push?: boolean; hash?: string; state?: HistoryState } = {}) {
  const url = new URL(location.href);
  if (currentSide() === "dark") url.searchParams.set("side", "dark");
  else url.searchParams.delete("side");
  if (vendor) url.searchParams.set("vendor", vendor);
  else url.searchParams.delete("vendor");
  url.hash = hash;
  history[push ? "pushState" : "replaceState"](state, "", url);
}

export function syncToggles() {
  const pressed = currentSide() === "dark" ? "true" : "false";
  for (const toggle of document.querySelectorAll("[data-toggle]")) toggle.setAttribute("aria-pressed", pressed);
}

/** 让太极方位与明/暗一致：不足则再逆时针转半圈（奇数=暗，偶数=明） */
export function syncTaiji(side: Side = currentSide()) {
  let flips = Number(root.style.getPropertyValue("--taiji-flips") || 0);
  const wantOdd = side === "dark";
  if ((flips % 2 === 1) !== wantOdd) flips += 1;
  root.style.setProperty("--taiji-flips", String(flips));
}

export function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
