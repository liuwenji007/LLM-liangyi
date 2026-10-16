import { centerNode, flipTo, markTarget } from "./flip";
import { onFilterChange } from "./filter";
import { currentSide, nodes, type Side } from "./state";

const nav = () => document.querySelector<HTMLElement>("#minimap");

let ticks = new Map<string, HTMLButtonElement>();
let frame = 0;

function labelOf(node: HTMLElement): string {
  const pip = node.querySelector<HTMLElement>(".pip");
  return pip?.getAttribute("aria-label") ?? node.dataset.id ?? "";
}

export function rebuildMinimap() {
  const root = nav();
  if (!root) return;
  root.replaceChildren();
  ticks = new Map();

  const list = nodes.filter((node) => !node.hidden);
  root.hidden = list.length === 0;
  if (!list.length) return;

  const frag = document.createDocumentFragment();
  for (const node of list) {
    const id = node.dataset.id ?? "";
    const side = (node.dataset.side as Side) || "light";
    const tick = document.createElement("button");
    tick.type = "button";
    tick.className = "minimap-tick";
    tick.dataset.id = id;
    tick.dataset.side = side;
    tick.title = labelOf(node);
    tick.setAttribute("aria-label", `跳到：${labelOf(node)}`);
    frag.append(tick);
    ticks.set(id, tick);
  }
  root.append(frag);
  updateMinimap();
}

function updateMinimap() {
  if (!ticks.size) return;
  const side = currentSide();
  const mid = window.innerHeight / 2;
  let bestId = "";
  let bestGap = Infinity;

  for (const node of nodes) {
    if (node.hidden || node.offsetParent === null) continue;
    const id = node.dataset.id ?? "";
    const tick = ticks.get(id);
    if (!tick) continue;
    tick.classList.toggle("is-face", tick.dataset.side === side);
    const rect = node.getBoundingClientRect();
    const visible = rect.bottom > 0 && rect.top < window.innerHeight;
    tick.classList.toggle("is-visible", visible);
    const gap = Math.abs(rect.top + rect.height / 2 - mid);
    if (gap < bestGap) {
      bestGap = gap;
      bestId = id;
    }
  }

  for (const [id, tick] of ticks) tick.classList.toggle("is-here", id === bestId);
}

function onScroll() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    updateMinimap();
  });
}

async function onClick(event: Event) {
  const tick = (event.target as Element).closest<HTMLButtonElement>(".minimap-tick");
  if (!tick) return;
  const id = tick.dataset.id ?? "";
  const node = nodes.find((n) => n.dataset.id === id);
  if (!node) return;

  const side = node.dataset.side as Side;
  if (side !== currentSide()) {
    await flipTo(side, {
      origin: { x: window.innerWidth - 24, y: window.innerHeight / 2 },
      targetId: id,
      fromId: id,
      push: true,
    });
    return;
  }
  centerNode(node);
  markTarget(node);
  updateMinimap();
}

export function initMinimap() {
  const root = nav();
  if (!root) return;
  rebuildMinimap();
  onFilterChange(rebuildMinimap);
  root.addEventListener("click", (event) => {
    void onClick(event);
  });
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  new MutationObserver(onScroll).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-side"],
  });
}
