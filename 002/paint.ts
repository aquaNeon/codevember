import { CanvasTexture, SRGBColorSpace } from "three";

const PX_PER_M = 640;
const LEAD = "rgb(40,37,34)";
const LEAD_PX = 6;
const FRAME_PX = 14;
const QUARRY_PX = 86;
const BORDER_PX = 74;
const PETALS = 12;
// coloured glass stays translucent, lead is the only opaque part
const GLASS = {
  quarry: "rgba(236,226,196,0.34)",
  ruby: "rgba(150,16,30,0.9)",
  cobalt: "rgba(20,44,140,0.9)",
  amber: "rgba(226,140,20,0.88)",
  emerald: "rgba(16,100,62,0.9)",
  violet: "rgba(80,30,112,0.88)",
};

// STAINED GLASS
// a leaded rose in the middle, clear diamond quarries around it, a jewelled border
export function paint(w: number, h: number) {
  const c = document.createElement("canvas");
  const W = Math.round(w * PX_PER_M);
  const H = Math.round(h * PX_PER_M);
  c.width = W;
  c.height = H;
  const g = c.getContext("2d");
  if (g) draw(g, W, H);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function draw(g: CanvasRenderingContext2D, W: number, H: number) {
  const b = BORDER_PX;
  const cx = W / 2;
  const cy = H / 2;
  const R = H * 0.34;
  g.lineJoin = "round";
  g.lineCap = "round";

  // QUARRIES
  g.fillStyle = GLASS.quarry;
  g.fillRect(b, b, W - 2 * b, H - 2 * b);
  g.save();
  g.beginPath();
  g.rect(b, b, W - 2 * b, H - 2 * b);
  g.clip();
  g.strokeStyle = LEAD;
  g.lineWidth = LEAD_PX * 0.8;
  g.beginPath();
  for (let k = -H; k < W + H; k += QUARRY_PX) {
    g.moveTo(k, 0);
    g.lineTo(k + H * 0.7, H);
    g.moveTo(k, H);
    g.lineTo(k + H * 0.7, 0);
  }
  g.stroke();
  g.restore();

  // BORDER
  // ruby lengths broken by cobalt blocks, amber squares in the corners
  const run = (x: number, y: number, len: number, along: "x" | "y") => {
    const n = Math.max(3, Math.round(len / 150));
    const step = len / n;
    for (let i = 0; i < n; i++) {
      const s = i * step;
      g.fillStyle = i % 2 ? GLASS.cobalt : GLASS.ruby;
      if (along === "x") g.fillRect(x + s, y, step, b);
      else g.fillRect(x, y + s, b, step);
      g.strokeStyle = LEAD;
      g.lineWidth = LEAD_PX;
      if (along === "x") g.strokeRect(x + s, y, step, b);
      else g.strokeRect(x, y + s, b, step);
    }
  };
  run(b, 0, W - 2 * b, "x");
  run(b, H - b, W - 2 * b, "x");
  run(0, b, H - 2 * b, "y");
  run(W - b, b, H - 2 * b, "y");
  for (const [x, y] of [
    [0, 0],
    [W - b, 0],
    [0, H - b],
    [W - b, H - b],
  ]) {
    g.fillStyle = GLASS.amber;
    g.fillRect(x, y, b, b);
    g.strokeRect(x, y, b, b);
    g.fillStyle = GLASS.emerald;
    g.beginPath();
    g.arc(x + b / 2, y + b / 2, b * 0.24, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  }

  // ROSE
  // clear the quarries under it, then ring, petals, eye
  g.save();
  g.globalCompositeOperation = "destination-out";
  g.beginPath();
  g.arc(cx, cy, R, 0, Math.PI * 2);
  g.fill();
  g.restore();

  const sector = (r0: number, r1: number, a0: number, a1: number, fill: string) => {
    g.beginPath();
    g.arc(cx, cy, r1, a0, a1);
    g.arc(cx, cy, r0, a1, a0, true);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
    g.stroke();
  };
  g.strokeStyle = LEAD;
  g.lineWidth = LEAD_PX;
  const seg = (Math.PI * 2) / PETALS;
  for (let i = 0; i < PETALS * 2; i++) {
    const a = (i * seg) / 2 - Math.PI / 2;
    sector(R * 0.82, R, a, a + seg / 2, i % 2 ? GLASS.emerald : GLASS.amber);
  }
  for (let i = 0; i < PETALS; i++) {
    const a = i * seg - Math.PI / 2;
    // each petal is a pointed arch, leaded inside the ring
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * R * 0.3, cy + Math.sin(a) * R * 0.3);
    g.quadraticCurveTo(
      cx + Math.cos(a - seg * 0.5) * R * 0.9,
      cy + Math.sin(a - seg * 0.5) * R * 0.9,
      cx + Math.cos(a) * R * 0.8,
      cy + Math.sin(a) * R * 0.8,
    );
    g.quadraticCurveTo(
      cx + Math.cos(a + seg * 0.5) * R * 0.9,
      cy + Math.sin(a + seg * 0.5) * R * 0.9,
      cx + Math.cos(a) * R * 0.3,
      cy + Math.sin(a) * R * 0.3,
    );
    g.fillStyle = i % 2 ? GLASS.cobalt : GLASS.ruby;
    g.fill();
    g.stroke();
  }
  // gaps between petals
  g.save();
  g.globalCompositeOperation = "destination-over";
  g.fillStyle = GLASS.violet;
  g.beginPath();
  g.arc(cx, cy, R * 0.82, 0, Math.PI * 2);
  g.fill();
  g.restore();
  sector(0, R * 0.3, 0, Math.PI * 2, GLASS.amber);
  sector(0, R * 0.12, 0, Math.PI * 2, GLASS.ruby);
  g.beginPath();
  g.arc(cx, cy, R * 0.82, 0, Math.PI * 2);
  g.stroke();

  // FRAME
  g.lineWidth = FRAME_PX;
  g.strokeRect(FRAME_PX / 2, FRAME_PX / 2, W - FRAME_PX, H - FRAME_PX);
  g.lineWidth = LEAD_PX;
  g.strokeRect(b, b, W - 2 * b, H - 2 * b);
}
