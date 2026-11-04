import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const ROOT = import.meta.dirname;
const DAY_RE = /^\d{3}$/;
const FONT_WAIT_MS = 800; // keep under the 1s css fallback delay in shared/style.css

// one entry per day folder that has an index.html
const days = readdirSync(ROOT).filter(
  (d) => DAY_RE.test(d) && existsSync(resolve(ROOT, d, "index.html")),
);

// REVEAL
// every page flags <html> once the serif is in, so the fade starts on real glyphs
const reveal: Plugin = {
  name: "cv-reveal",
  transformIndexHtml: () => [
    {
      tag: "script",
      injectTo: "head",
      children: `(()=>{const r=document.documentElement,f=document.fonts,t=setTimeout(o,${FONT_WAIT_MS});function o(){clearTimeout(t);r.setAttribute("data-cv-fonts","")}Promise.all([f.load('1em "Instrument Serif"'),f.load('italic 1em "Instrument Serif"')]).then(o,o)})()`,
    },
  ],
};

export default defineConfig({
  base: "./",
  plugins: [reveal],
  build: {
    rollupOptions: {
      input: {
        index: resolve(ROOT, "index.html"),
        ...Object.fromEntries(days.map((d) => [d, resolve(ROOT, d, "index.html")])),
      },
    },
  },
});
