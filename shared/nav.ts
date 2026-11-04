import { DAYS, READY, pad } from "./days";

// fills the prev / next links in the top bar
export function mountNav(day: number) {
  const nav = document.querySelector<HTMLElement>("[data-cv-nav]");
  if (!nav) return;
  const link = (n: number, text: string, rel: string) => {
    const ready = READY.has(n);
    const el = document.createElement(ready ? "a" : "span");
    el.textContent = text;
    if (el instanceof HTMLAnchorElement) {
      el.href = `../${pad(n)}/`;
      el.rel = rel;
      el.setAttribute("aria-label", `${rel === "prev" ? "Previous" : "Next"}: ${DAYS[n - 1]}`);
    } else el.setAttribute("aria-disabled", "true");
    return el;
  };
  nav.replaceChildren(link(day - 1, "← Prev", "prev"), link(day + 1, "Next →", "next"));
}
