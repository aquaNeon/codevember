import "../shared/style.css";
import { mountNav } from "../shared/nav";

const DAY = 1;
const HINT = {
  fold: "Lift an edge, fold it over",
  rest: "Rest. Let it rise",
  covered: "Tap to uncover",
} as const;

const root = document.querySelector<HTMLElement>("[data-cv]");

if (root && !root.hasAttribute("data-cv-mounted")) {
  root.setAttribute("data-cv-mounted", "");
  mountNav(DAY);

  const canvas = root.querySelector<HTMLCanvasElement>("[data-cv-canvas]");
  const folds = root.querySelector<HTMLElement>("[data-cv-folds]");
  const hint = root.querySelector<HTMLElement>("[data-cv-hint]");
  const reset = root.querySelector<HTMLButtonElement>("[data-cv-reset]");
  const still = () => root.setAttribute("data-cv-still", "");

  if (!canvas || new URLSearchParams(location.search).has("still")) still();
  else {
    // three is the heavy part, load it after first paint
    import("./dough")
      .then(({ Dough }) => {
        const dough = new Dough(canvas);
        if (import.meta.env.DEV && location.search.includes("debug"))
          Object.assign(window, { dough });
        root.setAttribute("data-cv-live", "");
        dough.onState = (n, phase) => {
          if (folds) folds.textContent = `${n} / 4`;
          if (hint) hint.textContent = HINT[phase];
        };
        reset?.addEventListener("click", () => dough.reset());
        canvas.addEventListener("webglcontextlost", (e) => {
          e.preventDefault();
          dough.dispose();
          still();
        });
      })
      .catch(still);
  }
}
