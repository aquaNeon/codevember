const PX_PER_M = 640;
const LEAD = "rgb(40,37,34)";
const LEAD_PX = 5;
const FRAME_PX = 16;
const BORDER_PX = 64;
const RAYS = 22;
const ARCHES = 8;
const SPIRAL_TURNS = 2.6;
// pale ground stays thin, the motif is dense; only lead is fully opaque
const GLASS = {
  ground: "rgba(242,232,206,0.42)",
  rayA: "rgba(244,222,168,0.5)",
  rayB: "rgba(238,200,196,0.48)",
  lavender: "rgba(170,146,206,0.88)",
  rose: "rgba(226,146,160,0.88)",
  saffron: "rgba(236,166,46,0.9)",
  cream: "rgba(246,234,206,0.7)",
  coral: "rgba(218,96,70,0.9)",
  sky: "rgba(140,190,214,0.7)",
  sage: "rgba(160,186,130,0.72)",
  mist: "rgba(196,184,222,0.66)",
  leaf: "rgba(56,116,82,0.9)",
  leafHi: "rgba(112,160,96,0.9)",
  gold: "rgba(214,160,40,0.92)",
  frame: "rgba(232,170,52,0.82)",
};

export const PANE_W = 1.6;
export const PANE_H = 2.1; // portrait, like a window

// WINDOW
// art deco frame, an af klint sun of rings with rays, arches below,
// a fan lotus held between two spirals; plain 2d so the still can use it without three
export function art(w = PANE_W, h = PANE_H) {
  const c = document.createElement("canvas");
  const W = Math.round(w * PX_PER_M);
  const H = Math.round(h * PX_PER_M);
  c.width = W;
  c.height = H;
  const g = c.getContext("2d");
  if (g) draw(g, W, H);
  return c;
}

function draw(g: CanvasRenderingContext2D, W: number, H: number) {
  const b = BORDER_PX;
  const cx = W / 2;
  const horizon = H * 0.54;
  g.lineJoin = "round";
  g.lineCap = "round";
  g.strokeStyle = LEAD;
  g.lineWidth = LEAD_PX;

  const fillStroke = (fill: string) => glass(g, fill);

  g.save();
  g.beginPath();
  g.rect(b, b, W - 2 * b, H - 2 * b);
  g.clip();
  g.fillStyle = GLASS.ground;
  g.fillRect(0, 0, W, H);

  // RAYS
  // deco sunburst above the horizon
  const sunY = H * 0.3;
  const sunR = W * 0.2;
  g.save();
  g.beginPath();
  g.rect(0, 0, W, horizon);
  g.clip();
  const step = (Math.PI * 2) / RAYS;
  for (let i = 0; i < RAYS; i++) {
    const a0 = i * step - Math.PI / 2;
    g.beginPath();
    g.moveTo(cx, sunY);
    g.arc(cx, sunY, H * 1.2, a0, a0 + step);
    g.closePath();
    fillStroke(i % 2 ? GLASS.rayA : GLASS.rayB);
  }
  g.restore();

  // SUN
  // concentric rings, af klint's disc
  const rings = [GLASS.lavender, GLASS.rose, GLASS.saffron, GLASS.cream, GLASS.coral];
  for (let i = 0; i < rings.length; i++) {
    g.beginPath();
    g.arc(cx, sunY, sunR * (1 - i / rings.length), 0, Math.PI * 2);
    fillStroke(rings[i]);
  }
  // a split through the inner rings, light and dark halves
  g.beginPath();
  g.moveTo(cx, sunY - sunR * 0.6);
  g.lineTo(cx, sunY + sunR * 0.6);
  g.stroke();

  // ARCHES
  // nested half circles rising from the sill
  const archY = H - b;
  const archFills = [GLASS.sky, GLASS.sage, GLASS.mist, GLASS.cream];
  for (let i = ARCHES - 1; i >= 0; i--) {
    const r = W * 0.12 + i * ((horizon - b) / ARCHES) * 1.35;
    g.beginPath();
    g.rect(b, horizon, W - 2 * b, H);
    g.save();
    g.clip();
    g.beginPath();
    g.arc(cx, archY, r, Math.PI, Math.PI * 2);
    g.closePath();
    fillStroke(archFills[i % archFills.length]);
    g.restore();
  }
  g.beginPath();
  g.moveTo(0, horizon);
  g.lineTo(W, horizon);
  g.stroke();

  // LEAVES
  // tall vs from the sill, mirrored
  const baseY = H - b;
  const lotusY = H * 0.74;
  for (const s of [-1, 1]) {
    leaf(g, cx + s * 20, baseY, cx + s * W * 0.3, lotusY - H * 0.06, 34, GLASS.leaf);
    leaf(g, cx + s * 10, baseY, cx + s * W * 0.16, lotusY + H * 0.02, 26, GLASS.leafHi);
  }

  // SPIRALS
  for (const s of [-1, 1]) spiral(g, cx + s * W * 0.25, lotusY + H * 0.05, s, GLASS.leaf);

  // LOTUS
  // a fan of petals, outer then inner, a gold seed at the base
  fan(g, cx, lotusY, W * 0.26, 7, [GLASS.saffron, GLASS.coral, GLASS.rose]);
  fan(g, cx, lotusY, W * 0.15, 5, [GLASS.rose, GLASS.lavender]);
  g.beginPath();
  g.arc(cx, lotusY, W * 0.045, 0, Math.PI * 2);
  fillStroke(GLASS.gold);
  g.restore();

  // FRAME
  // saffron band cut into lengths, gold corner blocks with a rose eye
  g.fillStyle = GLASS.frame;
  g.beginPath();
  g.rect(0, 0, W, H);
  g.rect(b, b, W - 2 * b, H - 2 * b);
  g.fill("evenodd");
  g.beginPath();
  for (let x = b + W * 0.2; x < W - b - 10; x += W * 0.2) {
    g.moveTo(x, 0);
    g.lineTo(x, b);
    g.moveTo(x, H - b);
    g.lineTo(x, H);
  }
  for (let y = b + H * 0.16; y < H - b - 10; y += H * 0.16) {
    g.moveTo(0, y);
    g.lineTo(b, y);
    g.moveTo(W - b, y);
    g.lineTo(W, y);
  }
  g.stroke();
  for (const [x, y] of [
    [0, 0],
    [W - b, 0],
    [0, H - b],
    [W - b, H - b],
  ]) {
    g.beginPath();
    g.rect(x, y, b, b);
    fillStroke(GLASS.gold);
    g.beginPath();
    g.arc(x + b / 2, y + b / 2, b * 0.22, 0, Math.PI * 2);
    fillStroke(GLASS.rose);
  }
  g.strokeRect(b, b, W - 2 * b, H - 2 * b);
  g.lineWidth = FRAME_PX;
  g.strokeRect(FRAME_PX / 2, FRAME_PX / 2, W - FRAME_PX, H - FRAME_PX);
}

// GLASS
// a piece replaces whatever lies under it, so layers never show through each other
function glass(g: CanvasRenderingContext2D, fill: string) {
  g.save();
  g.globalCompositeOperation = "destination-out";
  g.fillStyle = "#000";
  g.fill();
  g.restore();
  g.fillStyle = fill;
  g.fill();
  g.stroke();
}

// a long blade from base to tip, bowing outward
function leaf(
  g: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  tx: number,
  ty: number,
  wid: number,
  fill: string,
) {
  const mx = (ax + tx) / 2;
  const my = (ay + ty) / 2;
  const bow = (tx - ax) * 0.25;
  g.beginPath();
  g.moveTo(ax - wid / 2, ay);
  g.quadraticCurveTo(mx - wid + bow, my, tx, ty);
  g.quadraticCurveTo(mx + wid + bow, my + wid, ax + wid / 2, ay);
  g.closePath();
  glass(g, fill);
}

// fan of rounded petals opening upward from a point
function fan(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  n: number,
  fills: string[],
) {
  const from = Math.PI * 1.08;
  const span = Math.PI * 0.84;
  const each = span / n;
  for (let i = 0; i < n; i++) {
    const a0 = from + i * each;
    const a1 = a0 + each;
    const am = (a0 + a1) / 2;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a0) * r * 0.86, y + Math.sin(a0) * r * 0.86);
    g.quadraticCurveTo(
      x + Math.cos(am) * r * 1.18,
      y + Math.sin(am) * r * 1.18,
      x + Math.cos(a1) * r * 0.86,
      y + Math.sin(a1) * r * 0.86,
    );
    g.closePath();
    glass(g, fills[i % fills.length]);
  }
}

// SPIRAL
// af klint's snail: a band winding out from the centre, s mirrors it
function spiral(g: CanvasRenderingContext2D, x: number, y: number, s: number, fill: string) {
  const steps = 90;
  const end = Math.PI * 2 * SPIRAL_TURNS;
  const grow = 9;
  const band = 15;
  const at = (t: number, off: number) => {
    const r = Math.max(0, 6 + grow * t - off);
    const a = -Math.PI / 2 + s * t;
    return [x + Math.cos(a) * r, y + Math.sin(a) * r];
  };
  g.beginPath();
  for (let i = 0; i <= steps; i++) {
    const [px, py] = at((end * i) / steps, 0);
    if (i) g.lineTo(px, py);
    else g.moveTo(px, py);
  }
  for (let i = steps; i >= 0; i--) {
    const [px, py] = at((end * i) / steps, band);
    g.lineTo(px, py);
  }
  g.closePath();
  glass(g, fill);
}
