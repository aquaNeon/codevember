import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const ROOT = import.meta.dirname;
const DAY_RE = /^\d{3}$/;

// one entry per day folder that has an index.html
const days = readdirSync(ROOT).filter(
  (d) => DAY_RE.test(d) && existsSync(resolve(ROOT, d, "index.html")),
);

export default defineConfig({
  base: "./",
  build: {
    rollupOptions: {
      input: {
        index: resolve(ROOT, "index.html"),
        ...Object.fromEntries(days.map((d) => [d, resolve(ROOT, d, "index.html")])),
      },
    },
  },
});
