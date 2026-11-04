import "./style.css";
import { DAYS, READY, pad } from "./days";

const list = document.querySelector<HTMLOListElement>("[data-cv-days]");

if (list && !list.hasAttribute("data-cv-mounted")) {
  list.setAttribute("data-cv-mounted", "");
  DAYS.forEach((name, i) => {
    const n = i + 1;
    const ready = READY.has(n);
    const li = document.createElement("li");
    const row = document.createElement(ready ? "a" : "span");
    if (row instanceof HTMLAnchorElement) row.href = `./${pad(n)}/`;
    const num = document.createElement("small");
    num.className = "mono";
    num.textContent = pad(n);
    const title = document.createElement("strong");
    title.textContent = name;
    const tag = document.createElement("small");
    tag.className = "mono";
    tag.textContent = ready ? "View →" : "Soon";
    row.append(num, title, tag);
    li.append(row);
    list.append(li);
  });
}
