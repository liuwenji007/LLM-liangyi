import { nodes } from "./state";

let open: { node: HTMLElement; pinned: boolean } | null = null;
let openTimer = 0;
let closeTimer = 0;
let suppressFocusOpen = false;

function parts(node: HTMLElement) {
  return {
    pip: node.querySelector<HTMLButtonElement>(".pip")!,
    peek: node.querySelector<HTMLElement>(".peek")!,
  };
}

export function openPeek(node: HTMLElement, pinned = false) {
  window.clearTimeout(openTimer);
  window.clearTimeout(closeTimer);
  if (open && open.node !== node) closePeek();
  const { pip, peek } = parts(node);
  peek.hidden = false;
  pip.setAttribute("aria-expanded", "true");
  node.classList.add("is-peeking");
  open = { node, pinned: pinned || (open?.node === node && open.pinned) };
}

export function closePeek() {
  window.clearTimeout(openTimer);
  window.clearTimeout(closeTimer);
  if (!open) return;
  const { pip, peek } = parts(open.node);
  peek.hidden = true;
  pip.setAttribute("aria-expanded", "false");
  open.node.classList.remove("is-peeking");
  open = null;
}

export function initPeek() {
  for (const node of nodes) {
    const { pip, peek } = parts(node);

    const enter = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      window.clearTimeout(closeTimer);
      if (open?.node === node) return;
      window.clearTimeout(openTimer);
      openTimer = window.setTimeout(() => openPeek(node), 120);
    };

    const leave = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      window.clearTimeout(openTimer);
      if (open?.node !== node || open.pinned) return;
      closeTimer = window.setTimeout(closePeek, 200);
    };

    pip.addEventListener("pointerenter", enter);
    pip.addEventListener("pointerleave", leave);
    peek.addEventListener("pointerenter", enter);
    peek.addEventListener("pointerleave", leave);

    pip.addEventListener("click", () => {
      if (open?.node === node && open.pinned) closePeek();
      else openPeek(node, true);
    });

    pip.addEventListener("focus", () => {
      if (!suppressFocusOpen && pip.matches(":focus-visible")) openPeek(node);
    });

    node.addEventListener("focusout", (event) => {
      const next = event.relatedTarget as Node | null;
      if (open?.node === node && next && !node.contains(next)) closePeek();
    });
  }

  document.addEventListener("pointerdown", (event) => {
    if (open && !open.node.contains(event.target as Node)) closePeek();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !open) return;
    const { pip } = parts(open.node);
    closePeek();
    suppressFocusOpen = true;
    pip.focus();
    suppressFocusOpen = false;
  });
}
