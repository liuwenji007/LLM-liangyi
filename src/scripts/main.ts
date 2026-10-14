import { applyFilter } from "./filter";
import { centerNode, initFlip, markTarget } from "./flip";
import { initFloating } from "./floating";
import { closePeek, initPeek } from "./peek";
import { currentSide, nodeById, readUrl, syncToggles, writeUrl } from "./state";

history.scrollRestoration = "manual";

initPeek();
initFlip();
initFloating();
syncToggles();

const url = readUrl();
const hashNode = url.hash ? nodeById.get(url.hash) : undefined;
const vendor = hashNode && url.vendor && hashNode.dataset.vendor !== url.vendor ? "" : url.vendor;
applyFilter(vendor);

if (hashNode) {
  requestAnimationFrame(() => {
    centerNode(hashNode);
    if (hashNode.dataset.side === currentSide()) markTarget(hashNode);
    writeUrl({ hash: hashNode.dataset.id, state: { anchorId: hashNode.dataset.id, center: true } });
  });
}

document.querySelector("#filters")?.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>("[data-vendor-choice]");
  if (!button) return;
  closePeek();
  applyFilter(button.dataset.vendorChoice ?? "");
  writeUrl();
});

document.querySelector("#timeline")?.addEventListener("click", async (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>("[data-copy]");
  if (!button) return;
  const id = button.dataset.copy ?? "";
  const side = nodeById.get(id)?.dataset.side;
  const link = new URL(location.pathname, location.origin);
  if (side === "dark") link.searchParams.set("side", "dark");
  link.hash = id;
  try {
    await navigator.clipboard.writeText(link.href);
    button.textContent = "已复制";
  } catch {
    button.textContent = "复制失败";
  }
  window.setTimeout(() => {
    button.textContent = "复制链接";
  }, 1500);
});
