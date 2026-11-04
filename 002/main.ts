import "../shared/style.css";
import { mountNav } from "../shared/nav";
import type { Phase } from "./pane";

const DAY = 2;
const HINT: Record<Phase, string> = {
  whole: "Pull the sling back, let go",
  aiming: "Let go to shoot",
  flying: "Drag sideways to hold time",
  held: "Drag to scrub, tap to play",
  mending: "Tap to let it fly",
};

const root = document.querySelector<HTMLElement>("[data-cv]");

if (root && !root.hasAttribute("data-cv-mounted")) {
  root.setAttribute("data-cv-mounted", "");
  mountNav(DAY);

  const canvas = root.querySelector<HTMLCanvasElement>("[data-cv-canvas]");
  const time = root.querySelector<HTMLElement>("[data-cv-time]");
  const count = root.querySelector<HTMLElement>("[data-cv-count]");
  const hint = root.querySelector<HTMLElement>("[data-cv-hint]");
  const rewind = root.querySelector<HTMLButtonElement>("[data-cv-rewind]");
  const still = () => root.setAttribute("data-cv-still", "");

  if (!canvas || new URLSearchParams(location.search).has("still")) still();
  else {
    // three is the heavy part, load it after first paint
    import("./pane")
      .then(({ Pane }) => {
        const pane = new Pane(canvas);
        if (import.meta.env.DEV && location.search.includes("debug"))
          Object.assign(window, { pane });
        root.setAttribute("data-cv-live", "");
        pane.onState = (t, n, phase) => {
          if (time) time.textContent = `${t.toFixed(2)} s`;
          if (count) count.textContent = String(n);
          if (hint) hint.textContent = HINT[phase];
          if (rewind) rewind.disabled = phase === "whole";
        };
        rewind?.addEventListener("click", () => pane.rewind());
        canvas.addEventListener("webglcontextlost", (e) => {
          e.preventDefault();
          pane.dispose();
          still();
        });
      })
      .catch(still);
  }
}
