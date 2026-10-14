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

const DURATION = 1200;
const INK_STEPS = 32;

/*
 * 墨滴落下时迅速化开，越往外渗得越慢。
 * 晕边比实心部分大，放大到 SPREAD_VISIBLE 时晕边已经盖满屏幕，慢渗要在这之前完成；
 * 剩下的时间把实心部分推到边角，否则拆掉过渡层时半透明的边角会跳一下。
 */
const SPREAD_VISIBLE = 0.9;
const SPREAD_SETTLE = 0.9;

function inkSpread(t: number): number {
  if (t < SPREAD_SETTLE) return SPREAD_VISIBLE * (1 - (1 - t / SPREAD_SETTLE) ** 2.4);
  return SPREAD_VISIBLE + ((1 - SPREAD_VISIBLE) * (t - SPREAD_SETTLE)) / (1 - SPREAD_SETTLE);
}
const announcer = document.querySelector<HTMLElement>("#announce");
let busy = false;

/* 墨迹遮罩里，半径 INK_SOLID 以内保证完全不透明，往外是晕边和飞白 */
const INK_SOLID = 0.3;
let inkMask: string | undefined;

function inkBlot(): string {
  if (inkMask) return inkMask;
  const size = 512;
  const c = size / 2;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const blob = (x: number, y: number, r: number, alpha: number, hard = 0.55) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(0,0,0,${alpha})`);
    g.addColorStop(hard, `rgba(0,0,0,${alpha})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };
  blob(c, c, size * (INK_SOLID + 0.06), 1, 0.85);
  for (let i = 0; i < 26; i++) {
    const angle = (i / 26) * Math.PI * 2 + Math.random() * 0.4;
    const dist = size * (0.2 + Math.random() * 0.12);
    blob(c + Math.cos(angle) * dist, c + Math.sin(angle) * dist, size * (0.06 + Math.random() * 0.09), 0.9);
  }
  for (let i = 0; i < 140; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = size * (0.32 + Math.random() ** 2 * 0.14);
    blob(c + Math.cos(angle) * dist, c + Math.sin(angle) * dist, 0.8 + Math.random() * 2.6, 0.2 + Math.random() * 0.45, 0.2);
  }
  inkMask = canvas.toDataURL("image/png");
  return inkMask;
}

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
  // 实心部分在最后一帧刚好盖住最远的角，慢慢渗开的尾段都落在屏幕上
  const end = radius / INK_SOLID;
  root.style.setProperty("--ink", `url(${inkBlot()})`);
  root.classList.add("is-flipping");
  const transition = document.startViewTransition(apply);
  let ink: Animation | undefined;
  transition.ready
    .then(() => {
      const keyframes = Array.from({ length: INK_STEPS + 1 }, (_, i) => {
        const t = i / INK_STEPS;
        const s = end * inkSpread(t);
        const size = `${s}px ${s}px`;
        const position = `${center.x - s / 2}px ${center.y - s / 2}px`;
        return { offset: t, maskSize: size, maskPosition: position, webkitMaskSize: size, webkitMaskPosition: position };
      });
      ink = root.animate(keyframes, {
        duration: DURATION,
        // forwards：动画结束到过渡层拆掉之间还有一帧，不保持的话遮罩会退回 0，露出旧的一面
        fill: "forwards",
        pseudoElement: "::view-transition-new(root)",
      });
    })
    .catch(() => undefined);
  try {
    await transition.finished;
  } finally {
    ink?.cancel();
    root.classList.remove("is-flipping");
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
