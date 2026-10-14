import { applyFilter, renderStats, visibleCount } from "./filter";
import { closePeek } from "./peek";
import {
  currentSide,
  nodeById,
  nodes,
  readUrl,
  reducedMotion,
  root,
  syncToggles,
  writeUrl,
  type HistoryState,
  type Side,
} from "./state";

type Point = { x: number; y: number };

type FlipOptions = {
  origin?: Point;
  targetId?: string;
  fromId?: string;
  push?: boolean;
};

const DURATION = 600;
const EASING = "cubic-bezier(0.4, 0, 0.2, 1)";
const announcer = document.querySelector<HTMLElement>("#announce");
let busy = false;

export function centerOf(element: Element): Point {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function nearestCenterNode(): HTMLElement | undefined {
  const middle = window.innerHeight / 2;
  let best: HTMLElement | undefined;
  let bestGap = Infinity;
  for (const node of nodes) {
    if (node.hidden || node.offsetParent === null) continue;
    const rect = node.getBoundingClientRect();
    const gap = Math.abs(rect.top + rect.height / 2 - middle);
    if (gap < bestGap) {
      best = node;
      bestGap = gap;
    }
  }
  return best;
}

export function centerNode(node: HTMLElement) {
  const rect = node.getBoundingClientRect();
  window.scrollTo(0, window.scrollY + rect.top + rect.height / 2 - window.innerHeight / 2);
}

export function markTarget(node: HTMLElement) {
  node.classList.remove("is-target");
  void node.offsetWidth;
  node.classList.add("is-target");
  window.setTimeout(() => node.classList.remove("is-target"), 1300);
}

function announce(text: string) {
  if (!announcer) return;
  announcer.textContent = "";
  requestAnimationFrame(() => {
    announcer.textContent = text;
  });
}

export async function flipTo(side: Side, { origin, targetId, fromId, push = false }: FlipOptions = {}) {
  if (busy || side === currentSide()) return;
  closePeek();

  let target = targetId ? nodeById.get(targetId) : nearestCenterNode();
  if (target?.hidden) {
    applyFilter("");
    target = targetId ? nodeById.get(targetId) : target;
  }
  const keepTop = target && !targetId ? target.getBoundingClientRect().top : 0;

  if (push && fromId) {
    const from = nodeById.get(fromId);
    if (from) {
      const state: HistoryState = { anchorId: fromId, anchorTop: from.getBoundingClientRect().top };
      history.replaceState(state, "", location.href);
    }
  }

  const apply = () => {
    root.dataset.side = side;
    syncToggles();
    renderStats();
    if (target) {
      if (targetId) centerNode(target);
      else window.scrollBy(0, target.getBoundingClientRect().top - keepTop);
    }
    writeUrl({ push, hash: targetId ?? "", state: targetId ? { anchorId: targetId, center: true } : {} });
  };

  const finish = () => {
    busy = false;
    announce(`已切到${side === "dark" ? "暗史" : "明史"}，${visibleCount()} 条`);
    if (targetId && target) {
      markTarget(target);
      target.querySelector<HTMLElement>("h3")?.focus({ preventScroll: true });
    }
  };

  if (!document.startViewTransition || reducedMotion()) {
    apply();
    finish();
    return;
  }

  busy = true;
  const center = origin ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  const radius = Math.hypot(
    Math.max(center.x, window.innerWidth - center.x),
    Math.max(center.y, window.innerHeight - center.y),
  );
  const transition = document.startViewTransition(apply);
  transition.ready
    .then(() => {
      root.animate(
        {
          clipPath: [
            `circle(0px at ${center.x}px ${center.y}px)`,
            `circle(${radius}px at ${center.x}px ${center.y}px)`,
          ],
        },
        { duration: DURATION, easing: EASING, pseudoElement: "::view-transition-new(root)" },
      );
    })
    .catch(() => undefined);
  try {
    await transition.finished;
  } finally {
    finish();
  }
}

export function initFlip() {
  for (const toggle of document.querySelectorAll<HTMLButtonElement>("[data-toggle]")) {
    toggle.addEventListener("click", () => {
      const taiji = toggle.querySelector(".taiji") ?? toggle;
      flipTo(currentSide() === "dark" ? "light" : "dark", { origin: centerOf(taiji) });
    });
  }

  document.querySelector("#timeline")?.addEventListener("click", (event) => {
    const element = event.target as Element;
    const go = element.closest<HTMLElement>("[data-go]");
    if (go) {
      const node = nodeById.get(go.dataset.go ?? "");
      if (!node) return;
      const pip = node.querySelector(".pip") ?? node;
      flipTo(node.dataset.side as Side, {
        origin: centerOf(pip),
        targetId: node.dataset.id,
        fromId: node.dataset.id,
        push: true,
      });
      return;
    }
    const relation = element.closest<HTMLElement>("[data-rel]");
    if (relation) {
      const node = nodeById.get(relation.dataset.rel ?? "");
      if (!node) return;
      flipTo(node.dataset.side as Side, {
        origin: centerOf(relation),
        targetId: node.dataset.id,
        fromId: relation.closest<HTMLElement>(".node")?.dataset.id,
        push: true,
      });
    }
  });

  window.addEventListener("popstate", (event) => {
    closePeek();
    const url = readUrl();
    root.dataset.side = url.side ?? "light";
    syncToggles();
    applyFilter(url.vendor);
    const state = (event.state ?? {}) as HistoryState;
    const node = state.anchorId ? nodeById.get(state.anchorId) : undefined;
    if (!node) return;
    if (state.center) centerNode(node);
    else window.scrollBy(0, node.getBoundingClientRect().top - (state.anchorTop ?? 0));
  });
}
