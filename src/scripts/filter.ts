import { currentSide, nodes, setVendor } from "./state";

const stats = document.querySelector<HTMLElement>("#stats");
const empty = document.querySelector<HTMLElement>("#empty");

export function applyFilter(vendor: string) {
  setVendor(vendor);
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-vendor-choice]")) {
    button.setAttribute("aria-pressed", (button.dataset.vendorChoice ?? "") === vendor ? "true" : "false");
  }
  for (const node of nodes) node.hidden = Boolean(vendor) && node.dataset.vendor !== vendor;
  for (const month of document.querySelectorAll<HTMLElement>(".month")) {
    month.hidden = !month.querySelector(".node:not([hidden])");
  }
  let any = false;
  for (const year of document.querySelectorAll<HTMLElement>(".year")) {
    year.hidden = !year.querySelector(".node:not([hidden])");
    any ||= !year.hidden;
  }
  if (empty) empty.hidden = any;
  renderStats();
}

export function renderStats() {
  if (!stats) return;
  const visible = nodes.filter((node) => !node.hidden);
  const light = visible.filter((node) => node.dataset.side === "light").length;
  const dark = visible.length - light;
  stats.textContent = currentSide() === "light" ? `明史 ${light} 条 · 暗处 ${dark} 个点` : `暗史 ${dark} 条 · 明处 ${light} 个点`;
}

export function visibleCount(): number {
  const side = currentSide();
  return nodes.filter((node) => !node.hidden && node.dataset.side === side).length;
}
