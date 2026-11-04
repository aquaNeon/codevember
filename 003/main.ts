import "../shared/style.css";
import { mountNav } from "../shared/nav";

const DAY = 3;
const WORD = "melt";
const MAX_CHARS = 10;

const root = document.querySelector<HTMLElement>("[data-cv]");

if (root && !root.hasAttribute("data-cv-mounted")) {
  root.setAttribute("data-cv-mounted", "");
  mountNav(DAY);

  const canvas = root.querySelector<HTMLCanvasElement>("[data-cv-canvas]");
  const input = root.querySelector<HTMLInputElement>("[data-cv-word]");
  const swatch = root.querySelector<HTMLButtonElement>("[data-cv-palette]");
  const pour = root.querySelector<HTMLButtonElement>("[data-cv-pour]");
  const params = new URLSearchParams(location.search);
  const still = () => root.setAttribute("data-cv-still", "");

  if (!canvas || params.has("still")) still();
  else {
    // the word is cut from the serif, it has to be loaded before the first frame
    Promise.all([import("./smear"), document.fonts.load('400 100px "Instrument Serif"')])
      .then(([{ Smear, PALETTES }]) => {
        const smear = new Smear(canvas, WORD);
        if (import.meta.env.DEV && params.has("debug")) Object.assign(window, { smear });
        root.setAttribute("data-cv-live", "");

        input?.addEventListener("input", () => {
          const w = input.value.slice(0, MAX_CHARS);
          smear.setWord(w.trim() ? w : " ");
        });
        swatch?.addEventListener("click", () => {
          const next = PALETTES[(PALETTES.indexOf(smear.palette) + 1) % PALETTES.length];
          smear.setPalette(next);
          swatch.textContent = next;
        });
        pour?.addEventListener("click", () => smear.pour());
        canvas.addEventListener("webglcontextlost", (e) => {
          e.preventDefault();
          smear.dispose();
          still();
        });
      })
      .catch(still);
  }
}
