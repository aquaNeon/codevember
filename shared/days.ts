export const DAYS = [
  "Fold",
  "Shatter",
  "Melt",
  "Tangle",
  "Moss",
  "Orrery",
  "Hollow",
  "Tesseract",
  "Membrane",
  "Caustic",
  "Rust",
  "Feather",
  "Labyrinth",
  "Tension",
  "Mirage",
  "Spore",
  "Kelp",
  "Pendulum",
  "Erosion",
  "Cocoon",
  "Bolt",
  "Echo",
  "Magma",
  "Nest",
  "Veil",
  "Anamorph",
  "Burrow",
  "Hive",
  "Portal",
  "Dissolve",
] as const;

// add a day here once it ships
export const READY = new Set([1, 2]);

export const pad = (n: number) => String(n).padStart(3, "0");

// accent per shipped day, used by the index hover; each ready day also needs public/thumbs/<nnn>.jpg
export const ACCENT: Record<number, string> = { 1: "#a86a32", 2: "#2f6a5e" };
