export function initFloating() {
  const header = document.querySelector("#side-toggle");
  const floating = document.querySelector("#float-toggle");
  if (!header || !floating || !("IntersectionObserver" in window)) return;
  new IntersectionObserver(([entry]) => {
    floating.classList.toggle("is-shown", !entry.isIntersecting);
  }).observe(header);
}
