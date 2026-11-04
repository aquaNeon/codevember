import "../shared/style.css";
import { mountNav } from "../shared/nav";
import { art } from "./art";
import type { Phase } from "./pane";

const DAY = 2;
const IDLE_MS = 1200; // longest wait before the scene starts anyway
const HINT: Record<Phase, string> = {
  whole: "Pull the sling back, let go",
  aiming: "Let go to shoot",
  flying: "Hold to rewind",
  held: "Hold to rewind, tap to play",
  mending: "Let go to stop",
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
  const scrub = root.querySelector<HTMLInputElement>("[data-cv-scrub]");
  // STILL
  // the window itself, drawn flat; no three needed
  const still = () => {
    if (root.hasAttribute("data-cv-still")) return;
    root.setAttribute("data-cv-still", "");
    const frame = root.querySelector<HTMLElement>(".still");
    if (frame) frame.append(art());
  };

  if (!canvas || new URLSearchParams(location.search).has("still")) still();
  else {
    // three is the heavy part; wait for load and an idle moment, so a cold gpu
    // process has finished starting before the first webgl call blocks on it
    afterLoad(() => import("./pane"))
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
          if (scrub && !seeking) {
            scrub.disabled = !pane.shot;
            scrub.value = String(t);
          }
        };
        // TIMELINE
        // while the thumb is held the pane follows it, not the other way round
        let seeking = false;
        if (scrub) {
          scrub.max = String(pane.duration);
          const opts = { passive: true };
          scrub.addEventListener("pointerdown", () => (seeking = true), opts);
          scrub.addEventListener("pointerup", () => (seeking = false), opts);
          scrub.addEventListener("pointercancel", () => (seeking = false), opts);
          scrub.addEventListener("input", () => pane.seek(Number(scrub.value)));
        }
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

function afterLoad<T>(fn: () => Promise<T>) {
  return new Promise<void>((done) => {
    const idle = () =>
      "requestIdleCallback" in window
        ? requestIdleCallback(() => done(), { timeout: IDLE_MS })
        : setTimeout(done, 200);
    if (document.readyState === "complete") idle();
    else addEventListener("load", idle, { once: true });
  }).then(fn);
}
